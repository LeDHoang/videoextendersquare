# WebXR Reels Review & Meta Quest 3S Implementation Guide

## 1. Overview & Codebase Review

The Reels page feature consists of:
- **Backend (`ui/views/reels_view.py` & `ui/mediaserver.py`)**: Scans `output/` recursively for 4K master videos, serves them over a multi-threaded loopback HTTP media server (`ui/mediaserver.py`), and injects playlist metadata as JSON into the HTML player template.
- **Frontend (`ui/assets/reels.html`)**: A custom 1:1 square HTML5 video player embedded via Streamlit `components.html`. Features include:
  - Auto-playback and playlist auto-advance.
  - Video seek, volume, and play/pause controls.
  - Keyboard bindings (`W`/`S`/`A`/`D`/`Space`/`M`), wheel scroll, and touch swipe navigation.
  - Standard HTML5 Fullscreen API (`frame.requestFullscreen()`).

---

## 2. WebXR Feasibility & Implementation Options

**Difficulty Level**: Easy to Moderate (~1 to 2 hours of development effort).

There are 3 main approaches for playing Reels on a **Meta Quest 3S Browser**:

### Option A: Standard Meta Quest Browser Fullscreen (0 Dev Effort)
- **Mechanism**: Meta Quest Browser (Chromium-based) natively intercepts HTML5 `element.requestFullscreen()`.
- **User Experience**: Clicking the existing `FULL (⛶)` button in Quest Browser immediately expands the 2D video into a VR floating curved cinema screen inside the headset environment.
- **Effort**: **0 hours** (Works immediately out of the box).

### Option B: WebXR Immersive 3D/VR Cinema Session (1–2 Hours)
- **Mechanism**: Integrate WebXR (`navigator.xr.requestSession('immersive-vr')`) using **Three.js** or **A-Frame** in `ui/assets/reels.html`.
- **User Experience**: Renders an immersive 3D virtual environment or 360°/180° space with a 3D curved video screen. Quest Touch Controllers (triggers / thumbsticks) map to reel navigation (Next/Prev).
- **A-Frame Example**:
  ```html
  <script src="https://aframe.io/releases/1.4.2/aframe.min.js"></script>
  <a-scene embedded vr-mode-ui="enabled: true">
    <a-videosphere src="#reelsVideo" rotation="0 -90 0"></a-videosphere>
  </a-scene>
  ```
- **Effort**: **1–2 hours**.

### Option C: WebXR Layers API / `XRQuadLayer` (2–3 Hours)
- **Mechanism**: Use `XRMediaBinding.createQuadLayer(video)` to stream the video direct to Meta Quest's hardware VR compositor layer.
- **User Experience**: Eliminates WebGL texture copy overhead, offering maximum 4K image sharpness and low latency.
- **Effort**: **2–3 hours**.

---

## 3. Required Code Modification (Local Media Server)

In [ui/mediaserver.py](file:///Users/hoangleduc/Documents/%5Bez%5D/Coding/VR%20Tiktok/videoextendersquare/ui/mediaserver.py#L39), the media server currently binds to `127.0.0.1`:

```python
# ui/mediaserver.py:39
httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
```

### Impact:
When accessing the Streamlit app from Meta Quest 3S over Wi-Fi (e.g. `http://192.168.1.X:8501`), the Quest browser cannot fetch media from `http://127.0.0.1:<port>`.

### Required Fix:
Bind `mediaserver.py` to `"0.0.0.0"` or dynamically pass the host header so external network devices can stream videos.

---

## 4. How to Test on Meta Quest 3S

WebXR APIs (`navigator.xr`) require a **Secure Context** (`https://` or `localhost`).

### Method 1: USB-C Chrome Remote Debugging (Recommended & Easiest)
1. Connect Meta Quest 3S to Mac via USB-C.
2. Open Chrome on Mac and go to `chrome://inspect/#devices`.
3. Click **Port forwarding...** and map port `8501` to `localhost:8501`.
4. Put on Meta Quest 3S, open Meta Quest Browser, and visit:
   `http://localhost:8501`
5. *Benefit*: Quest treats `localhost` as a Secure Context, enabling WebXR without HTTPS certificate setup.

### Method 2: Secure HTTPS Tunnel (`ngrok` / `localtunnel`)
1. Start app: `streamlit run app.py`
2. Start secure tunnel:
   ```bash
   npx localtunnel --port 8501
   # or: ngrok http 8501
   ```
3. Open the secure `https://...` URL inside Meta Quest Browser.

### Method 3: Desktop Emulator Testing (No Headset Required)
1. Install **WebXR API Emulator** extension for Chrome/Firefox on Mac.
2. Open Chrome DevTools -> **WebXR tab**.
3. Simulate Meta Quest 3S pose and controllers directly in the desktop browser.
