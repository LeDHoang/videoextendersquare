import os
import tempfile
import uuid
import fal_client
from PIL import Image
from core import models as _models
from core.pricing import image_work_dimensions
from pipeline.utils import get_image_dimensions, calculate_square_padding, fetch_fal_result
from pipeline.video_worker import poll_job_status

def extract_image_url(result):
    """
    Extracts the image URL from a fal.ai API result dictionary.
    """
    if not isinstance(result, dict):
        raise ValueError(f"Invalid result type from fal.ai, expected dict: {result}")

    if "images" in result and isinstance(result["images"], list) and len(result["images"]) > 0:
        return result["images"][0]["url"]
    elif "image" in result and isinstance(result["image"], dict):
        return result["image"]["url"]
    elif "url" in result:
        return result["url"]

    # Deep search fallback
    for key, value in result.items():
        if isinstance(value, dict) and "url" in value:
            return value["url"]
        elif key == "url":
            return value

    raise ValueError(f"Could not find output URL in result: {result}")

def process_image(image_source, prompt, fal_key=None, status_callback=None, upscale_only=False, sharpening=0.0, upscale_engine="fast", upscale_model="fal-ai/clarity-upscaler", outpaint_model="fal-ai/image-apps-v2/outpaint", custom_outpaint_args=None, custom_upscale_args=None, billing_callback=None):
    """
    Saves image, uploads to Fal, calculates padding, calls Image Apps outpaint,
    and upscales the output using local FFmpeg or fal.ai cloud upscale.

    Args:
        image_source: Path to file (str) or raw bytes.
        prompt: Outpaint guidance prompt.
        fal_key: Optional fal.ai API key.
        status_callback: Optional status updates callback.
        upscale_only: If True, skips outpainting and only scales the original image.
        sharpening: Contrast Adaptive Sharpening (CAS) strength (0.0 to 1.0).
        upscale_engine: "fast" (FFmpeg Lanczos+CAS) or "fal" (fal.ai Cloud Upscaler).
        upscale_model: Model ID to use for fal.ai upscaling.

    Returns:
        tuple: (outpaint_url, upscaled_url)
    """
    # Use a per-call client instead of mutating the shared os.environ / the
    # module-level fal_client singleton — both are process-global state and
    # would race across concurrently running jobs with different keys.
    fal = fal_client.SyncClient(key=fal_key) if fal_key else fal_client.sync_client

    # Extra fal.ai arguments for CUSTOM(...) models (flat scalars only; media
    # URLs stay pipeline-managed). Applied only to non-stock models.
    def _extras(raw) -> dict:
        try:
            d = _models.parse_custom_args(raw)
        except ValueError:
            d = {}
        d.pop("video_url", None)
        d.pop("image_url", None)
        return d

    outpaint_custom = not _models.is_stock_image_outpaint_model(outpaint_model or "")
    upscale_custom = not _models.is_stock_image_upscale_model(upscale_model or "")
    use_extra_out = _extras(custom_outpaint_args) if outpaint_custom else {}
    use_extra_up = _extras(custom_upscale_args) if upscale_custom else {}

    # 1. Write source image to a temporary file if it's bytes
    temp_path = None
    temp_resized_path = None
    if isinstance(image_source, bytes):
        with tempfile.NamedTemporaryFile(delete=False, suffix=".png") as temp_file:
            temp_file.write(image_source)
            temp_path = temp_file.name
        image_to_process = temp_path
    else:
        image_to_process = image_source

    try:
        if upscale_only:
            temp_outpaint_path = image_to_process
            outpaint_url = None
        else:
            # 2. Get native dimensions
            width, height = get_image_dimensions(image_to_process)
            work_w, work_h, work_scale = image_work_dimensions(width, height)
            if work_scale < 1.0:
                uid_resize = uuid.uuid4().hex[:8]
                temp_resized_path = os.path.join(tempfile.gettempdir(), f"outpaint_input_{uid_resize}.png")
                with Image.open(image_to_process) as source_image:
                    source_image.resize((work_w, work_h), Image.Resampling.LANCZOS).save(temp_resized_path, "PNG")
                image_to_process = temp_resized_path
                width, height = work_w, work_h
            top, bottom, left, right = calculate_square_padding(width, height)

            # 3. Square inputs do not need Fal outpainting.
            if top == 0 and bottom == 0 and left == 0 and right == 0:
                if status_callback:
                    status_callback("Image is already square. Skipping outpainting phase.")
                outpaint_url = None
                temp_outpaint_path = image_to_process
            else:
                if not fal_key and not os.environ.get("FAL_KEY"):
                    raise ValueError("A Fal API key is required for cloud outpainting.")
                if status_callback:
                    status_callback("Uploading image to fal.ai CDN...")
                image_url = fal.upload_file(image_to_process)
                if status_callback:
                    status_callback(f"Submitting image outpainting job to {outpaint_model}...")
                if "image-apps-v2/outpaint" in (outpaint_model or "").lower():
                    arguments = {
                        "image_url": image_url,
                        "expand_top": top,
                        "expand_bottom": bottom,
                        "expand_left": left,
                        "expand_right": right,
                        "prompt": prompt,
                        "num_images": 1,
                        "output_format": "png",
                    }
                else:
                    arguments = {"image_url": image_url, "prompt": prompt}
                if use_extra_out:
                    arguments.update(use_extra_out)
                    if status_callback:
                        status_callback(f"Custom outpaint args applied: {sorted(use_extra_out)}")

                handler = fal.submit(outpaint_model, arguments=arguments)
                if billing_callback:
                    billing_callback("submitted", "outpaint", getattr(handler, "request_id", None))
                result = poll_job_status(
                    handler, "Image Outpainting", status_callback,
                    billing_callback=billing_callback, billing_stage="outpaint",
                )
                outpaint_url = extract_image_url(result)

                if status_callback:
                    status_callback("Downloading outpainted image for upscaling...")
                uid = uuid.uuid4().hex[:8]
                temp_outpaint_path = os.path.join(tempfile.gettempdir(), f"outpainted_temp_{uid}.png")
                fetch_fal_result(outpaint_url, temp_outpaint_path)

        # Determine output location
        uid = uuid.uuid4().hex[:8]
        output_image_path = os.path.join(tempfile.gettempdir(), f"delivery_4k_square_{uid}.png")
        if os.path.exists(output_image_path):
            os.unlink(output_image_path)

        if upscale_engine == "fal":
            if not fal_key and not os.environ.get("FAL_KEY"):
                raise ValueError("A Fal API key is required for cloud upscaling.")
            if status_callback:
                status_callback("Uploading image to fal.ai CDN for upscale...")

            if upscale_only or not outpaint_url:
                image_url_to_upscale = fal.upload_file(temp_outpaint_path)
            else:
                image_url_to_upscale = outpaint_url

            if status_callback:
                status_callback(f"Submitting image upscaling job to {upscale_model}...")

            arguments = {"image_url": image_url_to_upscale}
            if use_extra_up:
                arguments.update(use_extra_up)
                if status_callback:
                    status_callback(f"Custom upscale args applied: {sorted(use_extra_up)}")
            handler = fal.submit(upscale_model, arguments=arguments)
            if billing_callback:
                billing_callback("submitted", "upscale", getattr(handler, "request_id", None))
            result = poll_job_status(
                handler, "Image Upscaling", status_callback,
                billing_callback=billing_callback, billing_stage="upscale",
            )
            upscaled_url = extract_image_url(result)

            if status_callback:
                status_callback("Downloading upscaled image from fal.ai...")

            temp_fal_out = os.path.join(tempfile.gettempdir(), f"fal_upscaled_img_{uid}.png")
            fetch_fal_result(upscaled_url, temp_fal_out)
            temp_outpaint_path = temp_fal_out

        if status_callback:
            if upscale_engine == "fal":
                status_callback("Finalizing 4K square output via FFmpeg...")
            else:
                status_callback("Performing local high-quality Lanczos4 upscale via FFmpeg...")

        import subprocess
        # Use FFmpeg to scale the image using Lanczos and optional CAS sharpening
        vf_filter = "scale=3840:3840:flags=lanczos+accurate_rnd+full_chroma_int+full_chroma_inp"
        if sharpening > 0.0:
            vf_filter += f",cas={sharpening}"

        cmd = [
            "ffmpeg", "-y",
            "-i", temp_outpaint_path,
            "-vf", vf_filter,
            output_image_path
        ]

        subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

        # Clean up outpainted temp
        if not upscale_only and temp_outpaint_path != image_to_process and os.path.exists(temp_outpaint_path):
            os.unlink(temp_outpaint_path)

        return outpaint_url, output_image_path

    finally:
        # Clean up temp file
        if temp_path and os.path.exists(temp_path):
            os.unlink(temp_path)
        if temp_resized_path and os.path.exists(temp_resized_path):
            os.unlink(temp_resized_path)


