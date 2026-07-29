import os
import tempfile
import uuid
import fal_client
from pipeline.utils import get_image_dimensions, calculate_square_padding

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

def process_image(image_source, prompt, fal_key=None, status_callback=None, upscale_only=False, sharpening=0.0, upscale_engine="fast", upscale_model="fal-ai/clarity-upscaler"):
    """
    Saves image, uploads to fal, calculates padding, calls flux/outpaint, 
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
    if (not upscale_only) or (upscale_engine == "fal"):
        if fal_key:
            os.environ["FAL_KEY"] = fal_key
            
        if not os.environ.get("FAL_KEY"):
            raise ValueError("FAL_KEY must be set in the environment or passed as an argument.")

    # 1. Write source image to a temporary file if it's bytes
    temp_path = None
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
            top, bottom, left, right = calculate_square_padding(width, height)

            # 3. Upload to fal.ai CDN
            if status_callback:
                status_callback("Uploading image to fal.ai CDN...")
            image_url = fal_client.upload_file(image_to_process)

            # 4. Outpainting
            # If the image is already square, we can skip the outpainting phase and proceed directly to upscaling.
            if top == 0 and bottom == 0 and left == 0 and right == 0:
                outpaint_url = image_url
            else:
                if status_callback:
                    status_callback("Submitting image outpainting job...")
                arguments = {
                    "image_url": image_url,
                    "top": top,
                    "bottom": bottom,
                    "left": left,
                    "right": right,
                    "prompt": prompt
                }
                
                result = fal_client.subscribe(
                    "fal-ai/flux/outpaint",
                    arguments=arguments,
                    with_logs=True
                )
                outpaint_url = extract_image_url(result)

            # 5. Download intermediate for upscale processing
            if status_callback:
                status_callback("Downloading outpainted image for upscaling...")
                
            uid = uuid.uuid4().hex[:8]
            temp_outpaint_path = os.path.join(tempfile.gettempdir(), f"outpainted_temp_{uid}.png")
            import urllib.request
            urllib.request.urlretrieve(outpaint_url, temp_outpaint_path)
        
        # Determine output location
        uid = uuid.uuid4().hex[:8]
        output_image_path = os.path.join(tempfile.gettempdir(), f"delivery_4k_square_{uid}.png")
        if os.path.exists(output_image_path):
            os.unlink(output_image_path)
            
        if upscale_engine == "fal":
            if status_callback:
                status_callback("Uploading image to fal.ai CDN for upscale...")
            
            if upscale_only or not outpaint_url:
                image_url_to_upscale = fal_client.upload_file(temp_outpaint_path)
            else:
                image_url_to_upscale = outpaint_url

            if status_callback:
                status_callback(f"Submitting image upscaling job to {upscale_model}...")

            arguments = {"image_url": image_url_to_upscale}
            result = fal_client.subscribe(
                upscale_model,
                arguments=arguments,
                with_logs=True
            )
            upscaled_url = extract_image_url(result)

            if status_callback:
                status_callback("Downloading upscaled image from fal.ai...")

            import urllib.request
            temp_fal_out = os.path.join(tempfile.gettempdir(), f"fal_upscaled_img_{uid}.png")
            urllib.request.urlretrieve(upscaled_url, temp_fal_out)
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
        if not upscale_only and os.path.exists(temp_outpaint_path):
            os.unlink(temp_outpaint_path)
            
        return outpaint_url, output_image_path

    finally:
        # Clean up temp file
        if temp_path and os.path.exists(temp_path):
            os.unlink(temp_path)


