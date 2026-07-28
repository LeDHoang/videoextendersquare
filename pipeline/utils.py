import io
import cv2
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
    Reads a video from a file path and returns its dimensions and duration.
    
    Args:
        video_path: Path to the local video file.
        
    Returns:
        tuple: (width, height, duration_seconds)
    """
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise ValueError(f"Could not open video file: {video_path}")
        
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    frame_count = cap.get(cv2.CAP_PROP_FRAME_COUNT)
    cap.release()
    
    duration = 0.0
    if fps > 0:
        duration = frame_count / fps
        
    return width, height, duration

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
