import io
import json
import subprocess
from PIL import Image

def get_image_dimensions(image_path_or_bytes):
    """
    Reads an image from a file path or bytes and returns its dimensions.

    Args:
        image_path_or_bytes: Str path or bytes object.

    Returns:
        tuple: (width, height)
    """
    if isinstance(image_path_or_bytes, bytes):
        image_file = io.BytesIO(image_path_or_bytes)
    else:
        image_file = image_path_or_bytes

    with Image.open(image_file) as img:
        return img.size  # (width, height)

def get_video_dimensions_and_duration(video_path):
    """
    Reads a video from a file path and returns its dimensions and duration using ffprobe.

    Args:
        video_path: Path to the local video file.

    Returns:
        tuple: (width, height, duration_seconds)
    """
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
             "stream=width,height,duration", "-of", "json", video_path],
            capture_output=True,
            text=True,
            check=True
        )
        data = json.loads(result.stdout)
        stream = data["streams"][0]
        width = int(stream.get("width", 0))
        height = int(stream.get("height", 0))
        duration = float(stream.get("duration", 0))

        if width == 0 or height == 0:
            raise ValueError(f"Could not determine video dimensions for {video_path}")

        return width, height, duration
    except (subprocess.CalledProcessError, json.JSONDecodeError, KeyError, IndexError) as e:
        raise ValueError(f"Could not read video metadata from {video_path}: {e}")

def calculate_square_padding(width, height):
    """
    Calculates symmetric padding required to pad the shorter dimension 
    of the media to hit a perfect 1:1 aspect ratio.
    
    Args:
        width: Int width of the asset.
        height: Int height of the asset.
        
    Returns:
        tuple: (top, bottom, left, right) padding as integers.
    """
    if width > height:
        # Landscape
        diff = width - height
        top = diff // 2
        bottom = diff - top
        left = 0
        right = 0
    elif height > width:
        # Portrait
        diff = height - width
        left = diff // 2
        right = diff - left
        top = 0
        bottom = 0
    else:
        # Already square
        top = bottom = left = right = 0
        
    return top, bottom, left, right
