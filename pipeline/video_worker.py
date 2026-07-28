import os
import time
import tempfile
import fal_client
from pipeline.utils import get_video_dimensions_and_duration, calculate_square_padding

def extract_video_url(result):
    """
    Extracts the video URL from a fal.ai API result dictionary.
    """
    if not isinstance(result, dict):
        raise ValueError(f"Invalid result type from fal.ai, expected dict: {result}")
        
    if "video" in result and isinstance(result["video"], dict):
        return result["video"]["url"]
    elif "videos" in result and isinstance(result["videos"], list) and len(result["videos"]) > 0:
        return result["videos"][0]["url"]
    elif "url" in result:
        return result["url"]
        
    # Deep search fallback
    for key, value in result.items():
        if isinstance(value, dict) and "url" in value:
            return value["url"]
        elif key == "url":
            return value
            
    raise ValueError(f"Could not find output video URL in result: {result}")

def poll_job_status(handler, status_prefix, status_callback=None):
    """
    Polls the status of an asynchronous fal-client job until it completes or fails.
    """
    while True:
        status = handler.status(with_logs=True)
        
        if isinstance(status, fal_client.Queued):
            msg = f"{status_prefix}: Queued (position {status.position})"
            if status_callback:
                status_callback(msg)
        elif isinstance(status, fal_client.InProgress):
            msg = f"{status_prefix}: Processing..."
            if status.logs:
                # Append last log message if available
                last_log = status.logs[-1]["message"]
                msg += f" - {last_log}"
            if status_callback:
                status_callback(msg)
        elif isinstance(status, fal_client.Completed):
            msg = f"{status_prefix}: Completed!"
            if status_callback:
                status_callback(msg)
            break
            
        time.sleep(2.5)
        
    # Retrieve final result
    return handler.get()

def process_video(video_path, prompt, fal_key=None, status_callback=None, outpaint_model="fal-ai/klingx", upscale_model="fal-ai/seedvr-upscale-video", upscale_only=False, sharpening=0.0, upscale_engine="fast"):
    """
    Asynchronously processes a local video file: outpainting it to a 1:1 square aspect ratio 
    and then upscaling the result to 4K.
    
    Args:
        video_path: Path to the local video file.
        prompt: Outpaint guidance prompt.
        fal_key: Optional fal.ai API key.
        status_callback: Callable receiving string status updates.
        outpaint_model: Model ID to use for video outpainting.
        upscale_model: Model ID to use for video upscaling.
        upscale_only: If True, skips outpainting/uploading and only upscales locally.
        sharpening: Contrast Adaptive Sharpening (CAS) strength (0.0 to 1.0).
        upscale_engine: "fast" (FFmpeg Lanczos+CAS) or "studio" (VapourSynth znedi3+FineSharp).
        
    Returns:
        tuple: (outpaint_video_url, upscaled_video_url)
    """
    if not upscale_only:
        if fal_key:
            os.environ["FAL_KEY"] = fal_key
            
        if not os.environ.get("FAL_KEY"):
            raise ValueError("FAL_KEY must be set in the environment or passed as an argument.")

    if status_callback:
        status_callback("Analyzing video dimensions and duration...")

    # 1. Get video metadata
    width, height, duration = get_video_dimensions_and_duration(video_path)
    top, bottom, left, right = calculate_square_padding(width, height)
    
    if status_callback:
        status_callback(f"Native size: {width}x{height}, Duration: {duration:.2f}s. Padding: top={top}, bottom={bottom}, left={left}, right={right}")

    if upscale_only:
        temp_outpaint_path = video_path
        outpaint_url = None
    else:
        # 2. Upload video to fal.ai CDN
        if status_callback:
            status_callback("Uploading video file to fal.ai CDN...")
        video_url = fal_client.upload_file(video_path)
        
        # 3. Outpainting (if not already square)
        if top == 0 and bottom == 0 and left == 0 and right == 0:
            if status_callback:
                status_callback("Video is already square. Skipping outpainting phase.")
            outpaint_url = video_url
        else:
            if status_callback:
                status_callback(f"Submitting video outpainting job to {outpaint_model}...")
                
            arguments = {
                "video_url": video_url,
                "top": top,
                "bottom": bottom,
                "left": left,
                "right": right,
                "prompt": prompt
            }
            
            handler = fal_client.submit(outpaint_model, arguments=arguments)
            result = poll_job_status(handler, "Outpainting", status_callback)
            outpaint_url = extract_video_url(result)

        # 4. Upscaling
        if status_callback:
            status_callback("Downloading outpainted video for local upscaling...")
            
        temp_outpaint_path = os.path.join(tempfile.gettempdir(), "outpainted_video_temp.mp4")
        import urllib.request
        urllib.request.urlretrieve(outpaint_url, temp_outpaint_path)
    
    # Determine output location
    output_video_path = os.path.join(tempfile.gettempdir(), "delivery_4k_square.mp4")
    if os.path.exists(output_video_path):
        os.unlink(output_video_path)
        
    import subprocess
    
    if upscale_engine == "studio":
        if status_callback:
            status_callback("Performing studio-quality VapourSynth upscale (znedi3 + FineSharp). This will take a LONG time...")
            
        vpy_path = os.path.join(tempfile.gettempdir(), "upscale.vpy")
        pipeline_dir = os.path.dirname(os.path.abspath(__file__))
        with open(vpy_path, "w") as f:
            f.write(f'''import vapoursynth as vs
import os

core = vs.core
core.std.LoadPlugin('/opt/homebrew/lib/vapoursynth/vsznedi3.so')

abs_video_path = r'{os.path.abspath(temp_outpaint_path)}'
clip = core.ffms2.Source(abs_video_path)
# Double luma resolution using neural net predictor
clip = core.znedi3.nnedi3(clip, field=1, dh=True, nsize=0, nns=3, qual=2, pscrn=2)
# Finalize resize and scale chroma
clip = core.resize.Spline36(clip, width=3840, height=3840)
clip.set_output()
''')
        
        # Run vspipe and stream stdout into ffmpeg, applying CAS sharpening hardware-accelerated
        cmd = [
            "sh", "-c",
            f"vspipe -c y4m '{vpy_path}' - | ffmpeg -y -i - -vf 'cas=0.5' -c:v hevc_videotoolbox -q:v 65 -pix_fmt yuv420p -tag:v hvc1 '{output_video_path}'"
        ]
        
        try:
            subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except subprocess.CalledProcessError as e:
            raise RuntimeError(f"FFmpeg pipeline crashed with error:\\n{e.stderr.decode()}")
        finally:
            os.unlink(vpy_path)
    else:
        if status_callback:
            status_callback("Performing hardware-accelerated 4K VideoToolbox upscale via FFmpeg...")
            
        # Build the filter graph
        vf_filter = "scale=3840:3840:flags=lanczos+accurate_rnd+full_chroma_int+full_chroma_inp"
        if sharpening > 0.0:
            vf_filter += f",cas={sharpening}"
            
        # Run the hardware-accelerated Mac-optimized upscale command
        cmd = [
            "ffmpeg", "-y",
            "-i", temp_outpaint_path,
            "-vf", vf_filter,
            "-c:v", "hevc_videotoolbox",
            "-q:v", "65",
            "-pix_fmt", "yuv420p",
            "-tag:v", "hvc1",
            output_video_path
        ]
        
        subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    
    # Clean up intermediate video
    if not upscale_only and os.path.exists(temp_outpaint_path):
        os.unlink(temp_outpaint_path)
        
    return outpaint_url, output_video_path


