import os
import tempfile
import urllib.request
import streamlit as st
from dotenv import load_dotenv

# Load existing .env variables if present
load_dotenv()

# Set up page configurations
st.set_page_config(
    page_title="Square Extender 4K",
    page_icon="🎨",
    layout="wide",
    initial_sidebar_state="expanded"
)

# Custom CSS for rich aesthetics (dark mode, glassmorphism, gradient accents, modern font)
st.markdown("""
<style>
    @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&display=swap');

    /* Global Typography */
    html, body, .stApp, .stMarkdown, p, span, h1, h2, h3, h4, h5, h6 {
        font-family: 'Outfit', sans-serif;
    }

    /* Main Container Background */
    .stApp {
        background-color: #0d0f13;
        background-image: radial-gradient(circle at 10% 20%, rgba(90, 20, 150, 0.15) 0%, transparent 40%),
                          radial-gradient(circle at 90% 80%, rgba(20, 150, 200, 0.1) 0%, transparent 40%);
    }

    /* Sidebar Glassmorphism */
    section[data-testid="stSidebar"] {
        background-color: rgba(17, 22, 32, 0.85) !important;
        backdrop-filter: blur(12px);
        border-right: 1px solid rgba(255, 255, 255, 0.05);
    }

    /* Sidebar headers */
    section[data-testid="stSidebar"] h1, section[data-testid="stSidebar"] h2, section[data-testid="stSidebar"] h3 {
        color: #ffffff;
        font-weight: 600;
    }

    /* Custom Title Banner */
    .title-banner {
        background: linear-gradient(135deg, #6c5ce7 0%, #00cec9 100%);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        font-size: 3rem;
        font-weight: 800;
        margin-bottom: 0.5rem;
        text-align: center;
        letter-spacing: -1px;
    }

    .subtitle-banner {
        color: #a0aec0;
        font-size: 1.1rem;
        text-align: center;
        margin-bottom: 2rem;
        font-weight: 300;
    }
    
    /* Native Streamlit containers will use their default border styles to ensure perfect hitbox alignment */

    button[kind="primary"] {
        background: linear-gradient(135deg, #6c5ce7 0%, #a29bfe 100%) !important;
        color: white !important;
        font-weight: 600 !important;
        border: none !important;
        padding: 12px 24px !important;
        border-radius: 8px !important;
        transition: transform 0.2s, box-shadow 0.2s !important;
        width: 100%;
        margin-top: 15px;
    }
    
    button[kind="primary"]:hover {
        transform: translateY(-2px);
        box-shadow: 0 8px 20px rgba(108, 92, 231, 0.4);
    }

    /* Info Badges */
    .badge {
        display: inline-block;
        padding: 4px 10px;
        border-radius: 6px;
        font-size: 0.85rem;
        font-weight: 600;
        margin-right: 8px;
        margin-bottom: 8px;
    }
    .badge-size {
        background-color: rgba(0, 206, 201, 0.15);
        color: #00cec9;
        border: 1px solid rgba(0, 206, 201, 0.3);
    }
    .badge-padding {
        background-color: rgba(108, 92, 231, 0.15);
        color: #a29bfe;
        border: 1px solid rgba(108, 92, 231, 0.3);
    }

    /* Process buttons styling */
</style>
""", unsafe_allow_html=True)

# Helper function to safely fetch file bytes from Fal URL
def download_url_content(url):
    try:
        req = urllib.request.Request(
            url, 
            headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
        )
        with urllib.request.urlopen(req) as response:
            return response.read()
    except Exception as e:
        st.sidebar.error(f"Failed to fetch content from Fal CDN: {e}")
        return None

# Sidebar logic for API keys and endpoint settings
st.sidebar.title("🛠️ Configuration")

# Get key from environment if present
default_key = os.environ.get("FAL_KEY", "")

# Key input
fal_key = st.sidebar.text_input(
    "fal.ai API Key",
    type="password",
    value=default_key,
    help="Enter your FAL_KEY. If left blank, we will try to read from the .env file."
)

# Display Key Configuration status
if fal_key:
    st.sidebar.markdown(
        '<div style="background-color: rgba(46, 204, 113, 0.15); color: #2ecc71; border: 1px solid rgba(46, 204, 113, 0.3); padding: 8px 12px; border-radius: 8px; font-size: 0.9rem; margin-bottom: 20px;">'
        '🟢 API Key Configured'
        '</div>',
        unsafe_allow_html=True
    )
    # Set key in environment for safety
    os.environ["FAL_KEY"] = fal_key
else:
    st.sidebar.markdown(
        '<div style="background-color: rgba(231, 76, 60, 0.15); color: #e74c3c; border: 1px solid rgba(231, 76, 60, 0.3); padding: 8px 12px; border-radius: 8px; font-size: 0.9rem; margin-bottom: 20px;">'
        '🔴 API Key Required'
        '</div>',
        unsafe_allow_html=True
    )

# Model configuration options in sidebar
st.sidebar.subheader("🤖 Model Endpoints")

outpaint_img_model = st.sidebar.text_input(
    "Image Outpaint Model",
    value="fal-ai/flux/outpaint"
)

upscale_img_model = st.sidebar.text_input(
    "Image Upscale Model",
    value="fal-ai/clarity-upscaler"
)

outpaint_vid_model = st.sidebar.text_input(
    "Video Outpaint Model",
    value="fal-ai/klingx"
)

upscale_vid_model = st.sidebar.text_input(
    "Video Upscale Model",
    value="fal-ai/seedvr-upscale-video"
)

# Header
st.markdown('<div class="title-banner">SQUARE EXTENDER 4K</div>', unsafe_allow_html=True)
st.markdown('<div class="subtitle-banner">Transform images and videos into 1:1 format via outpainting and upscale them to 4K resolution.</div>', unsafe_allow_html=True)

# Main Navigation
tab_image, tab_video = st.tabs(["🖼️ Image Processor", "🎥 Video Processor"])

# --- IMAGE PROCESSOR TAB ---
with tab_image:
    col_left, col_right = st.columns([1, 1])
    
    with col_left:
        with st.container(border=True):
            st.subheader("1. Upload Image")
            uploaded_image = st.file_uploader(
                "Drag and drop an image here",
                key="image_uploader"
            )
        
        image_bytes = None
        is_valid_image = False
        if uploaded_image:
            # If the uploaded image changed, clear the previous output result
            img_change_key = f"prev_img_{uploaded_image.name}_{uploaded_image.size}"
            if img_change_key not in st.session_state:
                if "upscaled_image_result" in st.session_state:
                    del st.session_state["upscaled_image_result"]
                st.session_state[img_change_key] = True
                
            ext = uploaded_image.name.split(".")[-1].lower()
            if ext not in ["png", "jpg", "jpeg", "webp"]:
                st.error(f"Unsupported image format: {ext}. Please upload png, jpg, jpeg, or webp.")
            else:
                image_bytes = uploaded_image.read()
                is_valid_image = True
                
        if is_valid_image:
            from pipeline.utils import get_image_dimensions, calculate_square_padding
            try:
                width, height = get_image_dimensions(image_bytes)
                top, bottom, left, right = calculate_square_padding(width, height)
                
                st.markdown(
                    f'<span class="badge badge-size">Dimensions: {width}x{height}</span>'
                    f'<span class="badge badge-padding">Padding -> Top: {top}px, Bottom: {bottom}px, Left: {left}px, Right: {right}px</span>',
                    unsafe_allow_html=True
                )
                st.markdown("##### Original Image Preview")
                st.image(image_bytes, use_container_width=True)
            except Exception as e:
                st.error(f"Failed to read image metadata: {e}")
                
    with col_right:
        with st.container(border=True):
            st.subheader("2. Pipeline Settings")
            upscale_only_img = st.checkbox(
                "Upscale Only (Skip Outpainting)",
                value=False,
                help="Skip cloud-based outpainting. Only apply the local high-quality Lanczos4 upscale to 4K."
            )
            image_prompt = st.text_area(
                "Generative Outpaint Prompt",
                value="Seamlessly extend the background environment, high details, matching texture and lighting.",
                help="Describe the scene you want to fill in the padded margins.",
                disabled=upscale_only_img
            )
            sharpening_img = st.slider(
                "Local Sharpening Strength (CAS)",
                min_value=0.0,
                max_value=1.0,
                value=0.5,
                step=0.05,
                help="Enhance edge and texture details locally using Contrast Adaptive Sharpening (CAS). 0.0 is disabled, 1.0 is maximum sharpening."
            )
            
            process_img_button = st.button("🚀 Process Image to 4K Square", key="process_image_btn", type="primary")
        
        if process_img_button:
            if not uploaded_image or not is_valid_image:
                st.error("Please upload a valid image first.")
            elif not upscale_only_img and not fal_key:
                st.error("Please configure your fal.ai API key in the sidebar first.")
            else:
                # Clear old session result first
                if "upscaled_image_result" in st.session_state:
                    del st.session_state["upscaled_image_result"]
                with st.spinner("Executing outpaint & local upscaling pipeline..."):
                    status_container = st.empty()
                    
                    def update_img_logs(msg):
                        status_container.info(f"⏳ {msg}")
                        
                    try:
                        from pipeline.image_worker import process_image
                        
                        # Run the process
                        outpaint_url, upscaled_local_path = process_image(
                            image_source=image_bytes,
                            prompt=image_prompt if not upscale_only_img else None,
                            fal_key=fal_key if not upscale_only_img else None,
                            status_callback=update_img_logs,
                            upscale_only=upscale_only_img,
                            sharpening=sharpening_img
                        )
                        
                        st.session_state["upscaled_image_result"] = upscaled_local_path
                        status_container.success("Pipeline executed successfully!")
                        
                    except Exception as ex:
                        status_container.empty()
                        st.error(f"Pipeline error: {str(ex)}")
                        st.info("Check your API key validity and input coordinates/models.")

        # Persist and display result across reruns
        if "upscaled_image_result" in st.session_state and os.path.exists(st.session_state["upscaled_image_result"]):
            cached_img_path = st.session_state["upscaled_image_result"]
            st.markdown("---")
            st.subheader("✨ Delivery Assets")
            res_col1, res_col2 = st.columns(2)
            
            with res_col1:
                st.markdown("##### Original Asset")
                st.image(image_bytes, use_container_width=True)
                
            with res_col2:
                st.markdown("##### Final 4K Square Asset (3840x3840)")
                st.image(cached_img_path, use_container_width=True)
                
                # Download Button (Read directly from local upscaled file)
                with open(cached_img_path, "rb") as f:
                    final_bytes = f.read()
                st.download_button(
                    label="📥 Download 4K Image",
                    data=final_bytes,
                    file_name="delivery_4k_square.png",
                    mime="image/png"
                )

# --- VIDEO PROCESSOR TAB ---
with tab_video:
    col_v_left, col_v_right = st.columns([1, 1])
    temp_video_path = None
    is_valid_video = False
    
    try:
        with col_v_left:
            with st.container(border=True):
                st.subheader("1. Upload Video")
                uploaded_video = st.file_uploader(
                    "Drag and drop a video here",
                    key="video_uploader"
                )
            
            if uploaded_video:
                # If the uploaded video changed, clear the previous output result
                vid_change_key = f"prev_vid_{uploaded_video.name}_{uploaded_video.size}"
                if vid_change_key not in st.session_state:
                    if "upscaled_video_result" in st.session_state:
                        del st.session_state["upscaled_video_result"]
                    st.session_state[vid_change_key] = True
                    
                ext = uploaded_video.name.split(".")[-1].lower()
                if ext not in ["mp4", "mov", "avi", "webm"]:
                    st.error(f"Unsupported video format: {ext}. Please upload mp4, mov, avi, or webm.")
                else:
                    is_valid_video = True
            
            if is_valid_video:
                state_key = f"temp_vid_{uploaded_video.name}_{uploaded_video.size}"
                # Clean up old temp files from session state
                for k in list(st.session_state.keys()):
                    if k.startswith("temp_vid_") and k != state_key:
                        old_path = st.session_state[k]
                        if os.path.exists(old_path):
                            try:
                                os.unlink(old_path)
                            except Exception:
                                pass
                        del st.session_state[k]
                
                if state_key not in st.session_state:
                    uploaded_video.seek(0)
                    with tempfile.NamedTemporaryFile(delete=False, suffix=".mp4") as temp_in:
                        temp_in.write(uploaded_video.read())
                        temp_video_path = temp_in.name
                    st.session_state[state_key] = temp_video_path
                else:
                    temp_video_path = st.session_state[state_key]
                
                from pipeline.utils import get_video_dimensions_and_duration, calculate_square_padding
                try:
                    width, height, duration = get_video_dimensions_and_duration(temp_video_path)
                    top, bottom, left, right = calculate_square_padding(width, height)
                    
                    # 10s Safeguard Check
                    if duration > 10.0:
                        st.warning(
                            f"⚠️ Warning: The uploaded video is {duration:.1f} seconds long, which exceeds the 10-second threshold. "
                            "Processing times will be throttled. We strongly advise using video clips under 5 seconds for prototyping."
                        )
                        
                    # Display metadata badges
                    st.markdown(
                        f'<span class="badge badge-size">Dimensions: {width}x{height}</span>'
                        f'<span class="badge badge-size">Duration: {duration:.2f}s</span>'
                        f'<span class="badge badge-padding">Padding -> Top: {top}px, Bottom: {bottom}px, Left: {left}px, Right: {right}px</span>',
                        unsafe_allow_html=True
                    )
                    
                    st.markdown("##### Original Video Preview")
                    st.video(temp_video_path)
                except Exception as e:
                    st.error(f"Failed to read video metadata: {e}")
                    
        with col_v_right:
            with st.container(border=True):
                st.subheader("2. Pipeline Settings")
                upscale_only_vid = st.checkbox(
                    "Upscale Only (Skip Outpainting)",
                    value=False,
                    help="Skip cloud-based outpainting. Only apply the local hardware-accelerated 4K upscale.",
                    key="upscale_only_vid_checkbox"
                )
                video_prompt = st.text_area(
                    "Generative Outpaint Prompt",
                    value="Seamlessly extend the background environment, high details, matching texture and lighting.",
                    help="Describe the scene you want to fill in the padded margins of the video.",
                    key="video_prompt_area",
                    disabled=upscale_only_vid
                )
                upscale_engine_vid = st.radio(
                    "Local Upscaling Engine",
                    options=["Fast (Lanczos4 + CAS)", "Studio Quality (VapourSynth znedi3 + FineSharp)"],
                    help="Choose the algorithm for 4K upscaling. 'Fast' uses hardware-accelerated FFmpeg. 'Studio Quality' uses a neural network to reconstruct luma with zero ringing, but is extremely slow.",
                    key="video_upscale_engine"
                )
                
                sharpening_vid = st.slider(
                    "Local Sharpening Strength (CAS)",
                    min_value=0.0,
                    max_value=1.0,
                    value=0.5,
                    step=0.05,
                    help="Enhance edge and texture details locally using Contrast Adaptive Sharpening (CAS). 0.0 is disabled, 1.0 is maximum sharpening. Only applies to the Fast engine.",
                    key="video_sharpening_slider",
                    disabled=("Studio Quality" in upscale_engine_vid)
                )
                
                process_vid_button = st.button("🚀 Process Video to 4K Square", key="process_video_btn", type="primary")
            
            if process_vid_button:
                if not uploaded_video or not is_valid_video:
                    st.error("Please upload a valid video first.")
                elif not upscale_only_vid and not fal_key:
                    st.error("Please configure your fal.ai API key in the sidebar first.")
                else:
                    # Clear old session result first
                    if "upscaled_video_result" in st.session_state:
                        del st.session_state["upscaled_video_result"]
                    # Polling log updates container
                    log_container = st.empty()
                    
                    def update_logs(msg):
                        log_container.info(f"⏳ {msg}")
 
                    try:
                        from pipeline.video_worker import process_video
                        
                        outpaint_url, upscaled_local_path = process_video(
                            video_path=temp_video_path,
                            prompt=video_prompt if not upscale_only_vid else None,
                            fal_key=fal_key if not upscale_only_vid else None,
                            status_callback=update_logs,
                            outpaint_model=outpaint_vid_model if not upscale_only_vid else None,
                            upscale_model=upscale_vid_model if not upscale_only_vid else None,
                            upscale_only=upscale_only_vid,
                            sharpening=sharpening_vid,
                            upscale_engine="fast" if "Fast" in upscale_engine_vid else "studio"
                        )
                        
                        st.session_state["upscaled_video_result"] = upscaled_local_path
                        log_container.success("Pipeline executed successfully!")
                        
                    except Exception as vex:
                        log_container.empty()
                        st.error(f"Pipeline error: {str(vex)}")
                        st.info("Check your API key validity and input parameters/coordinates.")

            # Persist and display result across reruns
            if "upscaled_video_result" in st.session_state and os.path.exists(st.session_state["upscaled_video_result"]):
                cached_vid_path = st.session_state["upscaled_video_result"]
                st.markdown("---")
                st.subheader("✨ Delivery Assets")
                v_res_col1, v_res_col2 = st.columns(2)
                
                with v_res_col1:
                    st.markdown("##### Original Asset")
                    st.video(temp_video_path)
                    
                with v_res_col2:
                    st.markdown("##### Final 4K Square Asset (3840x3840)")
                    st.video(cached_vid_path)
                    with open(cached_vid_path, "rb") as file:
                        st.download_button(
                            label="Download 4K Video",
                            data=file,
                            file_name="extended_4k_video.mp4",
                            mime="video/mp4",
                            type="primary",
                            use_container_width=True
                        )

            st.markdown("---")
            st.subheader("🔍 Visual Quality Comparison Slider")
            st.write("Compare the batch-generated Fast upscale vs Studio upscale side-by-side. Drag the red handle to compare pixel-level differences.")
            
            # Find all batch-generated videos across input and input/1:1
            input_dir = "input"
            import glob
            fast_videos = glob.glob(os.path.join(input_dir, "*_fast.mp4")) + glob.glob(os.path.join(input_dir, "1:1", "*_fast.mp4"))
            
            if fast_videos:
                # Create a dictionary mapping video names to their base paths
                video_options = {os.path.basename(v).replace("_fast.mp4", ""): v.replace("_fast.mp4", "") for v in fast_videos}
                selected_video_name = st.selectbox("Select a video to compare:", list(video_options.keys()))
                
                base_path = video_options[selected_video_name]
                fast_vid = base_path + "_fast.mp4"
                studio_vid = base_path + "_studio.mp4"
                
                if os.path.exists(studio_vid):
                    import streamlit.components.v1 as components
                    # Videos are streamed locally via the python http.server running on port 8080 inside `input`
                    fast_rel_path = os.path.relpath(fast_vid, "input")
                    studio_rel_path = os.path.relpath(studio_vid, "input")
                    
                    fast_url = f"http://localhost:8080/{fast_rel_path}"
                    studio_url = f"http://localhost:8080/{studio_rel_path}"
                    
                    slider_html = f"""
                    <style>
                    .slider-container {{
                        position: relative;
                        width: 100%;
                        max-width: 600px;
                        margin: auto;
                        overflow: hidden;
                        border-radius: 8px;
                        background: #000;
                        aspect-ratio: 9/16;
                    }}
                    .slider-container video {{
                        position: absolute;
                        top: 0;
                        left: 0;
                        width: 100%;
                        height: 100%;
                        object-fit: contain;
                    }}
                    .video-after {{
                        clip-path: polygon(50% 0, 100% 0, 100% 100%, 50% 100%);
                    }}
                    .slider-handle {{
                        position: absolute;
                        top: 0;
                        bottom: 0;
                        left: 50%;
                        width: 4px;
                        background: #FF4B4B;
                        cursor: ew-resize;
                        z-index: 10;
                        transform: translateX(-50%);
                    }}
                    .slider-handle::after {{
                        content: '↔';
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        color: white;
                        font-weight: bold;
                        position: absolute;
                        top: 50%;
                        left: 50%;
                        width: 40px;
                        height: 40px;
                        background: #FF4B4B;
                        border-radius: 50%;
                        transform: translate(-50%, -50%);
                        box-shadow: 0 0 10px rgba(0,0,0,0.5);
                    }}
                    .labels {{
                        position: absolute;
                        bottom: 60px;
                        width: 100%;
                        display: flex;
                        justify-content: space-between;
                        padding: 0 20px;
                        box-sizing: border-box;
                        pointer-events: none;
                        z-index: 5;
                    }}
                    .label {{
                        background: rgba(0,0,0,0.6);
                        color: white;
                        padding: 5px 10px;
                        border-radius: 4px;
                        font-family: sans-serif;
                        font-size: 14px;
                    }}
                    .controls-bar {{
                        position: absolute;
                        bottom: 0;
                        left: 0;
                        width: 100%;
                        background: rgba(0,0,0,0.7);
                        padding: 10px;
                        display: flex;
                        justify-content: center;
                        gap: 15px;
                        z-index: 20;
                        box-sizing: border-box;
                        opacity: 0;
                        transition: opacity 0.3s;
                    }}
                    .slider-container:hover .controls-bar {{
                        opacity: 1;
                    }}
                    .controls-bar button {{
                        background: rgba(255,255,255,0.2);
                        border: none;
                        color: white;
                        font-size: 16px;
                        cursor: pointer;
                        padding: 5px 15px;
                        border-radius: 5px;
                        transition: background 0.2s;
                        font-family: sans-serif;
                    }}
                    .controls-bar button:hover {{
                        background: rgba(255,255,255,0.4);
                    }}
                    </style>
                    
                    <div class="slider-container" id="container">
                        <video id="video-before" src="{fast_url}" muted loop playsinline autoplay></video>
                        <video id="video-after" class="video-after" src="{studio_url}" muted loop playsinline autoplay></video>
                        <div class="slider-handle" id="slider"></div>
                        <div class="labels">
                            <div class="label">Fast (Lanczos4+CAS)</div>
                            <div class="label">Studio (ZNEDI3)</div>
                        </div>
                        <div class="controls-bar">
                            <button id="play-pause-btn">⏸ Pause</button>
                            <button id="fullscreen-btn">⛶ Fullscreen</button>
                        </div>
                    </div>
                    
                    <script>
                        const container = document.getElementById('container');
                        const slider = document.getElementById('slider');
                        const videoAfter = document.getElementById('video-after');
                        const videoBefore = document.getElementById('video-before');
                        const playPauseBtn = document.getElementById('play-pause-btn');
                        const fullscreenBtn = document.getElementById('fullscreen-btn');
                    
                        // Synchronize videos perfectly
                        videoBefore.addEventListener('play', () => videoAfter.play());
                        videoBefore.addEventListener('pause', () => videoAfter.pause());
                        videoBefore.addEventListener('seeked', () => {{
                            if(Math.abs(videoAfter.currentTime - videoBefore.currentTime) > 0.1){{
                                videoAfter.currentTime = videoBefore.currentTime;
                            }}
                        }});
                        
                        // Play/Pause logic
                        playPauseBtn.addEventListener('click', () => {{
                            if (videoBefore.paused) {{
                                videoBefore.play();
                                playPauseBtn.innerHTML = '⏸ Pause';
                            }} else {{
                                videoBefore.pause();
                                playPauseBtn.innerHTML = '▶ Play';
                            }}
                        }});
                        
                        // Fullscreen logic
                        fullscreenBtn.addEventListener('click', () => {{
                            if (!document.fullscreenElement) {{
                                container.requestFullscreen().catch(err => {{
                                    console.log(`Error attempting to enable full-screen mode: ${{err.message}}`);
                                }});
                            }} else {{
                                document.exitFullscreen();
                            }}
                        }});
                    
                        let isDragging = false;
                        
                        slider.addEventListener('mousedown', () => isDragging = true);
                        window.addEventListener('mouseup', () => isDragging = false);
                        window.addEventListener('mousemove', (e) => {{
                            if(!isDragging) return;
                            let rect = container.getBoundingClientRect();
                            let x = e.clientX - rect.left;
                            let percent = Math.max(0, Math.min(100, (x / rect.width) * 100));
                            slider.style.left = percent + '%';
                            videoAfter.style.clipPath = `polygon(${{percent}}% 0, 100% 0, 100% 100%, ${{percent}}% 100%)`;
                        }});
                    </script>
                    """
                    components.html(slider_html, height=750)
                else:
                    st.info("Studio version is still rendering in the background... Please check back in a few minutes.")
            else:
                st.info("No generated batch videos found in the input folder.")
                        
    finally:
        # Clean up temp file ONLY if it is not cached in session state
        if temp_video_path and os.path.exists(temp_video_path):
            is_cached = False
            for k in list(st.session_state.keys()):
                if k.startswith("temp_vid_") and st.session_state[k] == temp_video_path:
                    is_cached = True
                    break
            if not is_cached:
                try:
                    os.unlink(temp_video_path)
                except Exception:
                    pass
