# 3D Reels — stereoscopic SBS + top-bottom posts

Branch: `3dreels` (cut from `origin/main` @ `dcaa4e4`). Status: **implemented; verified on a Quest 3S (per-eye output, swap, pacing, TB decode); perceived depth still needs a hands-on check**.
This file is the full plan **and** the living checklist. Tick items and record deviations as work lands.

## Goal

Let users post native stereoscopic video and images. Two layouts are supported, each with **square eyes**:

| Layout | `stereo_layout` | Geometry | Left eye |
|---|---|---|---|
| Full side-by-side | `sbs` | `w == 2*h` (2:1) | left half |
| Full top-bottom | `tb` | `h == 2*w` (1:2) | top half |
| Normal | `mono` | anything (square after the pipeline) | — |

- Stereo posts **skip the extend/upscale pipeline** and are published as-is.
- **2D:** every surface shows the left eye as a normal square reel.
- **VR:** the WebXR player gives each eye its own square, so the content is true stereo.
- **Images:** single images and slideshows follow the same rules.
- **VR flows that must keep working:** reel playback, packs, slideshows and Earth mode.

## Asset contract

`media_path` stays the **original stereo file**. It is the identity for comments, likes and packs, and it is the VR source.

| File | Purpose |
|---|---|
| `<stem>.<ext>` | Original stereo file. VR source (`stereo_url`). |
| `<stem>-preview.mp4` | H.264 VR proxy. Made only when the source is not H.264 **or** its long side is over 4096. Capped at 4096 on the long side: SBS 4096×2048, TB 2048×4096. |
| `<stem>-mono.mp4` / `<stem>-mono.<img ext>` | Left-eye square at most 2160². SBS: `crop=iw/2:ih:0:0`. TB: `crop=iw:ih/2:0:0`. This is the 2D `url`. |
| `<stem>-mono-explore.mp4`, `<stem>-mono-poster.jpg` | Built by the existing explore preview and poster helpers **run on the mono file**, so they are square automatically. |

API fields on every post, card and feed item:
- **`url`, `preview_url`, `poster_url`:** mono assets. Every 2D surface keeps working unchanged.
- **`stereo_layout`:** `mono`, `sbs` or `tb`.
- **`stereo_url`:** the original file, or its H.264 proxy.
- **`width`, `height`:** the raw full frame.

**Legacy scan-only items** (no DB row, e.g. `output/testpipeline-3d` spatialize output):
- They get `stereo_layout: "sbs"` and `stereo_url == url`.
- 2D falls back to a CSS left-eye crop (`object-position`).

## Detection (`pipeline/stereo_detect.py`)

1. **Candidate:** `sbs` when `w == 2*h`, `tb` when `h == 2*w`.
2. **Metadata.** ffprobe stream side data "Stereo 3D" (`side by side` / `top and bottom`, not inverted), or the MKV/WebM `stereo_mode` tag (`left_right` / `top_bottom`). A match gives `method: "metadata"`.
3. **Content.**
   - Split the frame into the two eye halves, grayscale, 128×128 each, band-passed (minus a radius-4 blur, then a radius-1.2 blur so sub-pixel disparity still matches).
   - Score = `1 − min_s mean|A − shift_x(B, s)| / (1.128·stddev)` for `s ∈ [−12, 12]`. Disparity is horizontal for both layouts.
   - Videos use the median over 3 frames (15/50/85%); images use 1. A score of at least **0.72** means detected (`method: "content"`).
   - **No-parallax guard.** If the score passes but every judged frame aligns best at shift 0, the halves are one picture twice (a duplicated or re-graded split screen), not two eyes. That gives `detected: false`, `method: "no_parallax"`, and Upload Studio says why 3D is off. Real eyes differ by parallax somewhere: every real clip had at least 2 of 3 frames best at a 1–3 px shift. A real stereo file with almost no depth can be caught too, and the user can still switch 3D on by hand.
   - Calibration: six real 7680×3840 SBS reels in `output/testpipeline-3d` scored 0.81–0.98. Ordinary 2:1 and 1:2 crops and stretches scored 0.00–0.33, and a synthetic test pattern scored 0.64.
   - Split-screen run (2026-10-18, `scripts/dev/experiment_stereo_threshold.py`, 4 square clips × 10 edits):

     | Edit | Score | Detected |
     |---|---|---|
     | Two different clips | 0.01–0.17 | 0/4 |
     | Mirrored copy | 0.27–0.36 | 0/4 |
     | Zoomed copy | 0.18–0.33 | 0/4 |
     | Same clip 0.2 s apart | 0.62–0.71 | 0/3 |
     | Same clip 0.5 s / 2 s apart (SBS and TB) | 0.00–0.45 | 0/12 |
     | Duplicate (SBS and TB) | 0.97–0.98 | 0/8 (8/8 before the guard) |
     | Before/after colour grade | 0.83–0.89 | 0/4 (4/4 before the guard) |
     | Real SBS | 0.81–0.93 | 6/6 |

     The 0.72 threshold stays. A copy offset by about 0.2 s (0.71) is the closest miss, but it never aligns with a stable non-zero shift.
   - Flat or black frames are inconclusive.

The stage response carries `stereo: {candidate, detected, method, score}`.
- **Auto-on:** Upload Studio turns the 3D toggle on when the file is `detected`.
- **Manual:** the user can switch it on for any candidate, or off.

## VR rendering (`ui/assets/webxr_vr.js`)

- **Two separate flags.**
  - `stereoMode`, `setStereo` and `setPreviewStereo` still mean the desktop preview split-screen.
  - `sourceStereo` (`mono|sbs|tb`) via `setSourceStereo(layout)` means the content layout.
- **Stereo proxy canvas.** One canvas plus `CanvasTexture`, `VR_STEREO_EYE_CAP = 2048`: SBS 4096×2048, TB 2048×4096. Override with `?vrstereoeye=1536` for A/B.
- **Per-eye meshes.** Two eye clones of that texture share one `Source`, so there is one upload per frame.
  - SBS: `repeat(0.5,1)`, L offset `(0,0)`, R offset `(0.5,0)`.
  - TB: `repeat(1,0.5)`, L offset `(0,0.5)`, R offset `(0,0)`.
  - They are child meshes of `screenMesh` on layer 1 (left eye) and layer 2 (right eye). They inherit transform, curvature and the Earth-mode hide.
- **Mono screen mesh.** `screenMesh` maps the left eye. This covers the desktop preview and is the layer-0 raycast target.
  - While XR is presenting, its material is hidden so only the eye meshes draw.
- **2D player source choice** (`ui/assets/reels.html`).
  - The `stereo_url` is loaded only while XR is presenting.
  - Entering or exiting VR reloads the current item at the same playhead.
  - The blob cache is keyed by URL, so the mono and stereo variants never mix.

- **In-headset 3D chip** (`ui/assets/vr_ui_canvas.js`, dock header). While the screen is drawn per eye, the dock header shows an accent chip reading `3D SBS` or `3D TB`, between the reel title and the comment pill. It follows `textureStereo` (the layout really on screen), not the post's stored layout. A stereo post that fell back to 2D, for example after a failed stereo load, shows no chip. The desktop immersive preview shows the same chip.
- **3D filter (testing).** The Reels page filter rail has a `3D` toggle. It sets `media=stereo`, which `/api/reels`, `/api/reels/feed` and both player routes accept: only items whose post is stereo (cover or slide), or loose legacy-folder files that are exactly 2:1, are listed. It is a testing aid for now, not a product feature.

### Why not WebXR quad layers?

Per-eye meshes already give true stereo.

`XRMediaBinding.createQuadLayer(video, {layout: 'stereo-left-right' | 'stereo-top-bottom'})` is an optional later upgrade.
- **Gains:**
  - the compositor samples the video directly, which is sharper;
  - near-zero per-frame upload cost;
  - smoother frame pacing.
- **Costs:**
  - flat or cylinder shapes only;
  - scene UI such as comments, controls and glow cannot be depth-mixed over it without hole-punching;
  - it bypasses the existing black-flash and first-frame fixes.

## MAKE 3D — 2D-to-3D conversion

Branch: `feat/convert-to-3d` (cut from `3dreels`). A signed-in user turns a square 2D upload or a finished extend render into a full SBS post. It is free, runs on this server, and is off unless `SX_STEREO_CONVERT_ENABLED` is set **and** the packages in `requirements-3d.txt` are installed. `/api/config` reports both as `features.stereo_convert`.

- **Recipe (W8T, validated against Owl3D in the `owdl3d-reword` study, ledger §4.14).** `pipeline/spatial_worker.py`:
  - Depth comes from Video-Depth-Anything-Small (`vits`, Apache-2.0 code and weights). The code is vendored in `pipeline/third_party/video_depth_anything/` (see its `VENDORED.md`). The checkpoint downloads from Hugging Face on first use into `.models/`, relative to the server's working directory.
  - Shots split at an ffmpeg scene score ≥ 0.4. Shots under 12 frames merge into a neighbour. Depth runs once per shot, so the 32-frame window never spans a cut. Each shot is normalized by its own 2nd–98th percentile.
  - Per frame: a 5×5 dilate of near depth, bilinear upsampling, a forward softmax splat (weight `exp(20·near)`) and a background hole fill (`background_fill`). Each horizontal hole run is filled from its farther side, mirroring the background strip beyond that edge, so it copies background texture instead of stretching one pixel.
  - Far content shifts right by 1.3867% of the eye width (behind the screen). The nearest content sits on the screen plane (`POP_OUT` 0), as in W8T.
  - **Pop-out removed (2026-10-26).** On the Weeknd A/B in the Quest, pop-out 0.006 showed a band of horizontal streaks beside moving subjects. That was the background stretched across the soft depth edge. Frame 385 was measured with a patch-match score (right-eye pixels with no match on the same row of the left eye):
    - Arms: 1.31% of pixels with pop-out and nearest fill, 0.82% with pop-out 0, 0.79% with pop-out 0 and the background fill.
    - Rejected because they were worse: a 3×3 or no dilate, an edge-aware (guided) depth, and shock-sharpened depth edges.
    - The headset preferred pop-out 0 with the background fill ("C"). Depth range on Weeknd went from 1.69% to 1.17% of the eye, with nothing in front of the screen. The fill costs about 1 s more per 2106² frame.
  - **Why pop-out was tried (2026-10-23, superseded above).** W8T itself keeps everything behind the screen, with the nearest content on the screen plane. On the Quest 3S that read as comfortable but too weak. Disparity measured on the outputs used the full 1.4% budget, so it was not a bug.
    - In a headset A/B on a 3840² clip, three variants were compared: W8T as is, pop-out, and pop-out with a near-weighted curve (γ 1.6). Pop-out was preferred.
    - Pop-out widens the per-frame disparity spread by about 50% (0.99 → 1.52% of the eye). The far end stays the same.
  - **Resolution matters more than depth here.** On a 720² source the A/B variants looked the same, because the eye was only 700 px. Quest 3S shows about 20 px per degree, so the default screen of about 84° needs about 1700 px per eye to look sharp.
  - The render steps are numpy + OpenCV only, so CI tests them without torch.
- **Device.** cuda > mps > cpu. fp32 everywhere except CUDA, because fp16 gives all-NaN depth on MPS. One depth pass runs at a time per process, and the model is loaded once per process.
- **Output.** `eye_geometry` crops the parallax edge strip, an even `ceil(0.013867·W)` px, from all four sides of both eyes. The eye stays square, and each eye is capped at 2048 px (`VR_STEREO_EYE_CAP`). A 1080² source gives a 1048² eye, 2096×1048 SBS.
  - **Video:** H.264 (libx264 crf 20 superfast, yuv420p, bt709 tags, faststart), source audio copied, one output frame per source frame. It is already within the stereo cap, so publish makes no `-preview.mp4`.
  - **Image:** EXIF-transposed, then written as JPEG q95.
- **API.** `POST /api/stereo/convert` takes `{kind: "image"|"video", stage_id | job_id}`. It needs a signed-in user plus CSRF and origin checks.
  - It returns an ordinary image/video job, so progress, cancel, result and download use `/api/{kind}/jobs/{id}`. The job takes a queue slot. The limit is 10 converts per user per hour.
  - Errors: 404 when the flag is off; 503 `STEREO_CONVERT_UNAVAILABLE` when the packages are missing; 400 `WRONG_KIND`, `UNREADABLE_SOURCE`, `NOT_SQUARE`, `TOO_SMALL` (under 68×68) or `SOURCE_TOO_LONG` (over 60 s); the usual 403/429/503 for ownership, rate limit and a full queue.
- **Publish.** The result carries `stereo_layout: "sbs"`. Publish sends the convert `job_id` with that layout (`uploads._check_stereo_pointer`); any other layout is 422. The post then goes through the normal stereo path above (mono rendition, poster, explore preview), with `source="converted"`.
- **Upload Studio.** MAKE 3D is a third path for an already-square upload, next to SHARE DIRECTLY and EXTEND ANYWAY. It also appears once an extend render finishes. Either way it adds a MAKE 3D section with its own job runner, and the post summary reads `3D SIDE-BY-SIDE · MAKE 3D`.
- **Limits.**
  - Only square sources, a single image (no slideshows), and sources that are not already stereo.
  - Videos up to 60 s, since a whole clip's depth-resolution frames are held in memory.
  - Strength is fixed at 1.0 for users. Admin `/api/reels/spatialize` keeps its 0–2 strength and now shares the 60 s cap and the H.264 output.
  - HDR (PQ/HLG) sources are not tone-mapped. Untagged sources are read as bt709.
  - Image depth uses a single-frame pass (T=1). It correlates 0.95–0.99 with the 32-frame padded path and is about 40× faster on CPU.
- **On-device check (Quest 3S, 2026-10-23).** Three MAKE 3D posts (square video, square image, extend render) were checked in VR on the isolated stack (backend :8011, Vite :5176, `adb reverse`).
  - All three play the full SBS file with `textureStereo: sbs` on the 4096×2048 canvas. The left-eye mesh is on layer 1 at offset (0,0) and the right-eye mesh on layer 2 at (0.5,0). Both are visible, there are no render errors, and it renders at about 90 fps.
  - The Metacam capture shows one undoubled image with the `3D SBS` badge.
  - A person in the headset rated the depth comfortable but weaker than wanted.
  - **Capture note.** On this OS build `adb exec-out screencap` returns only the passthrough camera while an immersive session runs, so it cannot prove per-eye pixels. Use the meta-vr Metacam screenshot (composited view) together with `__test.getStereoState()`.
  - **Allow prompt.** The "Allow … immersive experiences?" prompt no longer accepts injected adb taps, so a person has to press Allow once per origin.
- **Server.** Production keeps `SX_STEREO_CONVERT_ENABLED=0` and the Docker image has no torch. See the VPS decision in `docs/to-beta.md` (AI inference).

## Limits / not supported

- **Not supported:**
  - half-SBS and half-TB;
  - inverted layouts (right-left, bottom-top);
  - Apple MV-HEVC spatial video;
  - 180°/360° projections.
- **Stereo publish restrictions:**
  - It must use the as-is path (`stage_id`) or a MAKE 3D job (`job_id`) in that job's layout (`sbs`). Extended (`job_id`) outputs are always mono.
  - Every slide in a stereo slideshow must share the same layout geometry.
- **The layout cannot be edited after publish.**
- **Square eyes only (product decision, 2026-10-18).** 3D stays limited to full SBS/TB with square eyes (an exact 2:1 or 1:2 frame). Non-square SBS such as 3840×1080 (16:9 per eye) stays mono and gets no 3D toggle.

## Checklist

- [x] Branch `3dreels` from `origin/main` (local `main` was stale). Upstream unset so a bare `git push` cannot hit `main`.
- [x] **Migration + model:** `20261015_0013_post_stereo_layout`, plus the `Post.stereo_layout` column. Bump `EXPECTED_SCHEMA_REVISION` and update `AGENTS.md` and the `docs/to-beta.md` mentions.
- [x] **Detection:** `pipeline/stereo_detect.py`, plus the `stereo` block in the `/api/video/upload` and `/api/image/upload` stage responses.
- [x] **Media:** `mono_sibling_path`, `make_left_eye_rendition`, the stereo cap in `make_web_preview`, and `-mono.` added to the derived-sibling skip filters.
- [x] **Publish:** `PublishRequest.stereo_layout`, the geometry and as-is validation, the slideshow check, atomic rendition generation, and the layout threaded into `create_or_update_post`.
- [x] **Serialization:** `post_card`, `reel_records` / `metadata_for_paths`, slide entries, the `reels.py` `_build_payload` (video and image, location feed), and the pack DB fallback.
- [x] **Legacy:** remove the filename regex, and map the `testpipeline-3d` folder to `sbs` on the server.
- [x] **2D player** (`reels.html`): URL choice by presenting state, blob cache keyed by URL, the swap on XR enter/exit, `setSourceStereo`, the legacy crop classes, the glow sampler, and the RES chip.
- [x] **VR engine:** split the flags, the stereo canvas, per-eye meshes, `applyStereoVisibility`, the per-eye layers in `renderStereoPair`, glow, diagnostics, and a `VR_VERSION` bump.
- [x] **VR flows:** next/prev/auto-next, seek, packs, slideshows, Earth open/close, the location feed, and enter/exit mid-reel.
- [x] **Upload Studio:** the 3D toggle (auto-on when detected), the skip path, the stage preview, the slideshow rule, the batch warning, the `mediaFormat` helpers, the 3D badges, and a rebuild of the prod bundle.
- [x] **Tests:** `tests/test_stereo_posts.py`, `tests/test_stereo_detect.py`, `web/tests/reels-stereo.test.js`, the `webxr-earth.test.js` cases, and the `UploadPage.test.jsx` cases.
- [x] **Docs:** this file, the partial ticks in the `docs/todolist.md` Phase 1 items, and the schema revision mentions.
- [~] **Verification:** `make test`; browser checks for upload, 2D, grids and the split-stereo preview; the IWER emulator flows; on-device Quest checks for depth, swap, frame pacing and the TB proxy decode. Everything is done except a person checking perceived depth in the headset.

## Notes / deviations

- **Legacy backfill in the migration.** The 0011 probe stored legacy media sizes, so `20261015_0013` marks exact 2:1 rows under `testpipeline-3d/` as `sbs`. On the dev DB that is 6 posts. The legacy importer applies the same folder rule (`server.media.legacy_stereo_layout`).
- **`stereo_crop` flag.** Stereo rows with no `<stem>-mono` rendition on disk (the legacy rows) serve `url == stereo_url` plus `stereo_crop: true`. The 2D player then CSS-crops to the left eye. `scripts/batch_stereo_mono.py` can generate the missing renditions.
- **Publish errors.**
  - The stereo checks return **422**: wrong geometry, a `job_id` source, or a mixed slideshow. Each eye must be at least 64×64.
  - A failed rendition returns **500** after removing every copied and derived file.
- **Blob cache.** It stays keyed by feed index, so the existing pruning keeps working. A parallel `blobSourceMap` records which URL each blob came from, and `blobFor(index, url)` only reuses a blob when the variant matches.
- **VR swap without `loadVideo`.** Entering or exiting VR calls `syncStereoSource()`, which the engine fires through the new `onEnterVR` / `onExitVR` callbacks. It swaps `src` in place and keeps the playhead and the play/pause state. It does not re-run `loadVideo`, which would record a second view and a second pack event.
- **Layout follows the uploaded frame.** The engine binds per-eye meshes from `textureStereo`, the layout of the frame actually uploaded, rather than from the host flag. A mono→stereo switch therefore holds the last mono frame until the first stereo frame arrives, keeping the v8.10 first-frame hold.
- **Test seams.** `__test.getStereoState()` and `__test.setXrSessionForTest()` let `webxr-earth.test.js` check per-eye layers, offsets and visibility without a headset.
- **Prod bundle.** `server/static/` and `web/dist/` are gitignored, so there is no bundle commit. `vite build` compiles cleanly; rebuild on deploy as usual.
- **Upload Studio toggle.**
  - It is a `ToggleRow` labelled "STEREOSCOPIC 3D · SIDE-BY-SIDE / TOP-BOTTOM". It turns on automatically when the stage says `detected`, with a hint giving the method.
  - An undetected exact 2:1 / 1:2 frame shows the toggle off, so a phone screen recording still goes to extend.
  - Switching it off goes back to the extender.
  - Slideshows offer the toggle only when every image is the same candidate.
  - Batch mode warns that 3D files render as flat 2D.
- **Badges.** Explore/profile/pack-gallery tiles append "3D" to their kind badge. Legacy raw stereo files get the `sx-stereo-crop-*` classes on tiles and pack covers.
- **Desktop split preview acts like a headset.** On `/reels/immersive-preview` with "SIDE-BY-SIDE STEREO" on, the player loads `stereo_url` and draws each half with the per-eye layers, exactly as XR does. The engine fires `onPreviewStereo` so the swap happens immediately. This is how stereo was verified without a Quest.
- **Bug found in browser verification (fixed).** Profile and feed `media_card` and the lazy `POST /api/reels/explore-preview` built grid assets from the original's name. That produced 2:1 `<stem>-explore.mp4` / `<stem>-poster.jpg` straddling both eyes. Both now use the `-mono` rendition, and `tests/test_stereo_posts.py` covers it.
- **Stereo proxy rule.** Mono uploads keep the old rule: an H.264 source plays as-is. Stereo uploads also get a `-preview.mp4` when an H.264 source is longer than 4096 px.
- **Stereo video publish is asynchronous.** The request copies the file, writes the post and builds only a left-eye poster, then returns. One background worker (`uploads._stereo_pool`) builds the `-mono.mp4` rendition, the VR proxy and the mono explore assets, then invalidates the scan cache. Until the rendition lands the post serves `stereo_crop: true`. Stereo images still build their rendition in the request (a PIL crop). Detection (`detect_stereo`) runs at staging time and stays synchronous.
- **Atomic derived files.** The rendition and proxy encoders write `.<name>.part` (`-f mp4`) and `os.replace` it, so a half-written file is never served or mistaken for a finished one. Scans skip dotfiles.
- **Proxy cap is enforced on read.** `stereo_paths` only serves a cached `-preview.mp4` whose long side is at most 4096 (probe cached by path, mtime and size); an older oversized proxy falls back to the original until `batch_stereo_mono.py` rebuilds it.
- **Grid assets before the rendition exists.** `POST /api/reels/explore-preview` crops the left eye straight from the stereo original (`crop=…,scale=-2:720`) when no `-mono` rendition exists, so tiles are square from the start. Image posts build the rendition on the spot instead.
- **Stereo load failure in VR.** The first failure falls back to the 2D rendition at the same playhead and retries the stereo file once after 5 s. A second failure stays on 2D and flashes "3D UNAVAILABLE — SHOWING 2D". Leaving the post clears the failure, so the next visit tries 3D again.
- **VR entry keeps the play/pause state.** Entering VR unmutes but no longer calls `play()`, so a reel paused in 2D stays paused in the headset.
- **Legacy folder rule needs 2:1.** `legacy_stereo_layout` marks a `testpipeline-3d/` file as `sbs` only when it is exactly 2:1 (probing the file when the size is unknown), matching migration 0013.

## Verification log (2026-10-16)

- **`make test`:** pytest 305, node 307, vitest 353, all green.
- **Isolated dev servers.** A backend on :8010 and Vite on :5183, with a migrated copy of the dev DB and a scratch `output/`. The other session's :8000 / :5173 servers were left untouched. Everything was removed afterwards.
- **Upload Studio.** A real 3840×1920 SBS clip was auto-detected ("3D SIDE-BY-SIDE DETECTED", content score). The stage showed the left eye 1920² with no extend sections, and publish produced:
  - the original, H.264 3840×1920, with no proxy needed;
  - `-mono.mp4` at 1920²;
  - `-mono-explore.mp4` and `-mono-poster.jpg` at 720².
- **2D Reels.** The player loads `-mono.mp4` (1920×1920). The RES chip reads `1920×1920 ×2` plus `3D SIDE-BY-SIDE`.
- **Profile grid.** Square left-eye posters and previews, with a "3D" badge.
- **Split-stereo preview.** Tinted samples were used: left eye red, right eye blue.
  - The SBS video (4096×2048 proxy), the TB video (2048×4096 proxy) and an SBS still each showed red in the left half and blue in the right.
  - Next and prev across TB→SBS rebuilt the proxy.
  - Earth round-trip: the screen hides in Earth mode and stereo is restored on return.
  - Turning split off swaps back to `-mono` at the same playhead.
- **Legacy crop.** With the rendition removed, the 2D player plays the raw 3840×1920 file with `stereo-crop-sbs` (object-position 0% 50%), showing only the red left eye.
- **Not yet verified on device.** These still need a Quest:
  - stereo depth;
  - the enter/exit swap inside a real XR session;
  - frame pacing at 2048/eye vs `?vrstereoeye=1536`;
  - TB 2048×4096 H.264 decode.

  Run the CDP probes in `scripts/debug-quest*.cjs`.
- **Detection note.** The colour-tinted test pairs, with a different tint per eye, score about 0.61–0.63, so they are not auto-detected. The manual toggle covers them. Real stereo footage scores 0.81–0.98.

### Pre-Quest QA sweep (2026-10-16)

A form and function pass over every surface a 3D post reaches. It ran on the same isolated stack: backend :8010 and Vite :5183, with an APFS clone of `output/` and a migrated DB copy. The seed was:
- two users;
- SBS and TB videos;
- a 3-slide SBS slideshow;
- the tinted SBS clip;
- time-synced and general comments;
- a mixed 3D + 2D pack;
- a DM share;
- `batch_stereo_mono.py` run over the 6 legacy `testpipeline-3d` posts, which built all 6 renditions.

**Passed.**
- **Explore, tag and location grids.** Square left-eye posters and previews, with "3D" and "#tag · 3D" badges. Tiles open the player at the post.
- **2D player.**
  - Plays `-mono` 1920². The RES chip reads `1920×1920 ×2 · 3D SIDE-BY-SIDE`.
  - 3D slideshow cycles mono slides.
  - Pop-up comment markers and ticker work. A new 0:05 comment shows its marker at 64.9%.
  - Docked fullscreen and the phone (375 px) pseudo-fullscreen show the square mono.
  - Legacy crop fullscreen shows the left eye only.
- **Sharing.**
  - The share link is `/reels?post=<id>` with a QR code.
  - The DM payload and MessagingPanel card use the mono explore and poster.
- **Packs.**
  - Gallery labels such as `01 · 3D · 0:05`, and the list resolution `1920×1920 ×2 · 3D`.
  - The pack player plays 3D and 2D items in 2D.
  - Editor rows and the library use mono posters.
  - The VR Collect overlay swaps the screen to the 2048² static card (mono) and restores the 4096×2048 SBS source on close.
- **Earth.**
  - The hover preview card plays the mono preview and poster.
  - Selecting a location loads the location feed with the stereo source in split preview.
  - The screen and its eye meshes hide in Earth mode and come back on return.
- **VR preview (split stereo).**
  - DOME, SQ CURVE and FLAT keep both eye meshes on the shared geometry.
  - Pop-up comments render over the stereo screen in both eyes.
  - Dock controls all work: comments, like, save, next/prev, earth and `share_reel`.
- **Header search.** Post results come from `media_card` with mono assets only. A result opens the player at that post (TB → `-mono.mp4` 1920², layout mono in 2D).
- **Profile.** Editing keeps `stereo_layout`. The highlight cover uses the mono poster.
- **Delete.** After a soft delete the post leaves:
  - search;
  - the ranked feed;
  - the `/api/reels` disk-scan feed;
  - the profile.

  Its `-mono*` files are skipped by the scanners, so they never show up as orphan tiles.
- **Moderation.** Reports carry no media, so there is nothing to crop.

**Bugs found and fixed.**
- **B1.** `media_card` and the lazy `POST /explore-preview` built 2:1 grid assets from the original stereo file. Both now use the `-mono` rendition, with tests in `tests/test_stereo_posts.py`.
- **B2.** With 3D on, the Upload Studio slideshow strip thumbnails were centre-cropped and straddled both eyes. They now get `sx-stereo-crop-{layout}` and show the left eye. Covered in `UploadPage.test.jsx`.

**Observations, not 3D bugs.**
- **VR Earth "all locations" restore was unwired (fixed, not 3D-specific).** The pre-Three.js engine restored all locations when Earth was pressed during a location feed (`toggleEarthMode` → `onRestoreAllLocations`). `0da05fa` dropped that call, so in VR a location feed had no way back to all locations. The dock's Earth button now reads `ALL LOCATIONS` while a location feed is active and Earth is closed, and pressing it calls `onRestoreAllLocations`. Pack mode keeps `QUEUE`; with Earth open the button still returns to reels. Engine `v8.20-20261016-earth-restore-all`, with tests in `web/tests/webxr-earth.test.js`. It is one self-contained commit and can be cherry-picked onto `main`.
- **Share links use the page origin.** In dev that is `localhost:5173`; this is pre-existing.
- **`/api/rewards/reels` returns 503 in the QA env.** Rewards were disabled there.

### Emulated XR session QA (Chrome + Immersive Web Emulator, 2026-10-16)

A real (emulated) `immersive-vr` session in Chrome with the Immersive Web Emulator (Quest 3 profile). Input was driven through the emulated controllers: pose set programmatically, trigger and thumbstick pressed through the device API, so dock presses went through the real ray, raycast and select path, not only through `__test` hooks. It ran on the same isolated stack (backend :8010, Vite :5183).

The seed above was extended with 10 real-footage posts made from local SBS samples:
- exact 2:1 and 1:2 derived clips;
- one 8K HEVC SBS clip;
- spread over Hanoi, Tokyo, Paris, NYC and Sydney.

`make test` was green afterwards: pytest 305, node 312, vitest 353.

**Detection on real footage.**
- Derived 2:1 SBS clips scored 0.807–0.903 and the TB clip 0.888, so all were detected by content.
- The original non-2:1 files got no candidate, which is by design (see the product gap below).
- The 8K HEVC source got a 4096×2048 H.264 `-preview.mp4` proxy, a 2160² `-mono.mp4` and 720² explore assets.

**Passed.**
- **Enter/exit.**
  - Entering XR swaps to the stereo file. For example, 3840×1920 gives `sourceStereo` `sbs` on the 4096×2048 canvas, with the mono screen material hidden.
  - Exit returns to `-mono.mp4` at the same playhead. Several cycles stayed stable.
- **Per-eye output in a true XR session.** With the emulator's stereo view on, the tinted SBS clip and a tinted TB clip showed red in the left eye and blue in the right.
- **Eye meshes.** Layers 1/2, and the right `repeat`/`offset` for SBS and for TB (2048×4096 canvas).
- **Mixed pack traversal in XR.** SBS → TB → 3D slideshow → mono images → end card. The layout switches per item.
- **Dock through the real controller ray and trigger.**
  - Comments panel, curvature, mode, mute, lock and play/pause all work.
  - Like and save send `PUT`, and next/prev navigate.
  - Follow is a no-op on your own post, which is correct.
  - Share opens the share dialog (see O3).
- **Earth in XR.**
  - Open and close from the dock.
  - Selecting Paris loads its location feed in XR: the TB 720×1440 stereo file on the 2048×4096 canvas.
  - Selecting Tokyo loads the SBS feed, and the 8K HEVC post plays its 4096×2048 H.264 proxy (readyState 4, advancing).
  - A real press on the `ALL LOCATIONS` dock button restores the full feed. With no location feed active, Earth opens again.
- **3D slideshow in XR.** Loads the stereo originals (3840×1920, not `-mono`) as `sbs`. Thumbstick X flicks step slides 1 → 2 → 3 → 2. The dock hides REW/FWD for images by design (`isControlVisible`).
- **Pop-up comments in XR.** They appear over the SBS stereo video on schedule (1.0 s, 2.0 s and 3.5 s).
- **Leak check.**
  - 4 exit/enter cycles kept the scene children constant (14), and the JS heap was collected (62 → 43 MB).
  - No console errors, and `getLastRenderError` stayed empty throughout.

**Bug found and fixed.**
- **F1.** A paused 3D reel started playing again after entering or leaving VR. The `<video autoplay>` attribute restarts playback when `syncStereoSource` swaps the src. The swap now calls `pause()` again when the reel was paused. Covered in `web/tests/reels-stereo.test.js`, and checked live: the reel stays paused at the same playhead.

**Observations: pre-existing, not 3D-specific (identical on `origin/main`).** O1–O3 are now fixed on `3dreels`; each fix was written against `origin/main` and cherry-picked.
- **O1, high: DB pool hold-and-wait deadlock (fixed in `efd199e`).**
  - **Mechanism.** `get_optional_auth` leaves its request session holding a pooled connection until the request ends. It only commits when `last_used_at` is at least 300 s old. Helpers then open their own `SessionLocal()`:
    - `unavailable_media_paths_for_viewer`;
    - `slide_media_paths` via `_scan_cached`;
    - `reel_records` / `metadata_for_paths` via `_location_catalog`, `_apply_filters` and `_build_payload`.
  - **Effect.** About 15 concurrent authenticated requests (the default QueuePool is 5 + 10 with a 30 s timeout) each hold one connection and wait for a second.
    - All 40 threadpool workers block, so even `/api/health` stops answering.
    - The swallowed timeouts chain 30 s waits per item, so one request held a connection for over 17 minutes.
    - The QA backend had to be restarted.
  - **Affected endpoints.** The same pattern is in:
    - `GET /api/reels/locations/{key}`;
    - `/api/reels/tags/{tag}`;
    - `GET /api/reels`;
    - `/api/reels/locations/activity`;
    - `/api/reels/comments`.

    Default `/api/reels/feed` commits first and is not affected.
  - **Fix (`efd199e`).** `get_optional_auth` now commits on every path that queried. The nested helpers take an optional `db`, and every `reels.py` route passes its request session. The per-item fallbacks no longer re-query. `tests/test_db_pool_isolation.py` checks for at most 1 checkout per request, including concurrent signed-in requests on `pool_size=1`. It runs on SQLite and PostgreSQL 15.
- **O2, medium: Earth hover preview request storm (fixed in `372b792`, engine `v8.21-20261016-earth-preview-cache`).** Before the fix, the preview fetch had no per-slug cache, no in-flight dedupe and no dwell.
  - **Trigger.** A ray resting on the Earth title label after a hover kept the panel-grace path (`updateEarthHoverFromRay`) re-hovering the last zone. That sent about 120 `GET /api/reels/locations/<slug>` requests per second for the same slug.
  - **Why it hurts.** Client aborts do not stop the server's sync handlers, so the requests feed O1 and wedge the backend. The globe's spin hold together with jitter at a zone edge causes the same flip-flop at a lower rate.
  - **Side bug.** An aborted fetch left `earthPreviewStatus` set to `error`.
  - **Fix (`372b792`).**
    - Panel grace restores a zone once per departure and no longer renews itself.
    - Per-location preview cache: 30 s TTL, LRU 32, with the in-flight request shared.
    - Leaving a zone no longer aborts the request; the late result fills the cache.
    - An AbortError is never reported as `error`, and real failures are held for 5 s.

    Covered in `web/tests/webxr-earth.test.js`.
- **O3, medium: SHARE REEL is invisible in feed-mode VR (fixed in `4ae8baf`).** SHARE REEL and REPORT (signed in) open DOM-only UI during feed-mode VR: the share dialog and `window.prompt`, which nobody sees in a headset. Pack mode exits VR first. **Fixed in `4ae8baf`:** `exitXrForDomUi()` now leaves XR before the share dialog or report prompt in every mode. Covered in `web/tests/reels-xr-dom-ui.test.js`.
- **Not a bug.** A NEXT pressed about 1.5 s after PREV looked dropped. No input is lost: the screen holds the previous frame until the new video has data (`FRESH_VISUAL_MAX_HOLD_MS` 2500).
- **Product gap.** SBS or TB footage whose eyes are not square has no 3D path. An example is 3840×1080 SBS (16:9 per eye), which covers most of the real samples. The toggle only appears for an exact 2:1 or 1:2 frame.

**Still needs a Quest.** The emulator proves the per-eye routing, but not:
- perceived depth;
- frame pacing at 2048/eye;
- TB 2048×4096 H.264 decode on the device.

Frame pacing and the TB decode are now covered by the on-device check below. Perceived depth still needs a person in the headset.

### On-device Quest check (Quest 3S, Quest Browser 152 / Chrome 152, 2026-10-16)

**Setup.**
- The Quest 3S was on USB (adb) and held awake with the `vrpowermanager.prox_close` broadcast.
- Quest Browser was driven from the Mac over CDP (`adb forward tcp:9222 localabstract:chrome_devtools_remote`).
- `adb reverse` for 5183/8010 let the headset load `http://localhost:5183`, which is a secure origin for WebXR.
- It ran on the same isolated stack: backend :8010 and Vite :5183, with a DB snapshot and an APFS clone of `output/`.
- The seed above was extended with two tinted samples:
  - a TB clip at 2160×4320, top red and bottom blue, which forces the 2048×4096 proxy;
  - a 2-slide tinted SBS still post.

**Entering VR.**
- CDP `Runtime.evaluate` with `userGesture: true` clicks `#vrBtn`.
- The first entry shows Quest Browser's "Allow localhost:5183 to open immersive experiences?" prompt. `Browser.grantPermissions(['vr'])` does not cover it, so Allow was tapped on the native button through `adb shell input tap`.
- Later entries need no prompt.

**Eye-buffer captures.** Captures come from `adb exec-out screencap`, which records both eye buffers. Each one used as proof differs from the previous capture or shows content not seen before (see the stale-capture note).

**Passed.**
- **True per-eye stereo on the device.** The tinted SBS video, the tinted SBS stills and the tinted TB clip (on its 2048×4096 proxy) all show red in the left eye and blue in the right. For example, TB read left (75, 27, 27) and right (10, 27, 97). So the SBS left half reaches the left eye, and the TB top half reaches the left eye.
- **Engine state on all six 3D posts.**
  - `sourceStereo` / `textureStereo` follow each layout.
  - Canvas is 4096×2048 for SBS and 2048×4096 for TB.
  - Offsets are L(0,0) R(0.5,0) for SBS and L(0,0.5) R(0,0) for TB.
  - The mono material is hidden while presenting, and `getLastRenderError` stayed empty.
- **2D on the Quest.** The deep link `/reels?post=<id>` plays the `-mono` rendition (1920², or 2160² for the big TB clip), and both eyes see only the red left eye.
- **Enter/exit swap.**
  - Exiting while paused at 3.2 s returns to `-mono` 1920² at 3.2 s, still paused.
  - Re-entering keeps the playhead (4.1 s) but resumes playback. `enterVR` deliberately unmutes and plays every reel on entry (`webxr_vr.js` "Entered immersive session"), so this is not 3D-specific.
- **Frame pacing.** Measured over 4 s windows with the display at 90 Hz.
  - Every 3D post ran at 86–90 fps, with p95 frame times of 12.3–14.4 ms.
  - Videos upload every decoded frame (29–33/s) with 0 dropped frames. Stills upload nothing.
  - Pacing was unchanged with screencaps running.
- **`stereoEye` 1536 vs 2048.** 3072×1536 gave 86.3 fps (p95 13.4 ms); 4096×2048 gave 86.5–87 fps (p95 ~14 ms). There is no measurable difference, so 2048 stays the default.
- **TB 2048×4096 H.264 proxy decode.** It decodes on the Quest 3S: 120 frames per 4 s, 0 dropped, at 86 fps. The planned fallback cap at 1920×3840 is not needed.
- **Video↔image switch.**
  - Video→image takes 46 ms once the image is cached; image→video takes 173 ms to the first upload.
  - A first, uncached 3840×1920 JPEG over USB takes longer. The previous frame holds meanwhile (the existing first-frame hold).
- **Earth.**
  - Opening Earth hides the screen and both eye meshes.
  - Selecting Hanoi returns to reels on its location feed with the stereo source, and stepping the feed switches between `sbs` and `tb` per item.
  - `ALL LOCATIONS` restores the feed and stays in stereo.
- **Comments.**
  - The comments panel opens over the stereo screen, and the eye meshes stay visible.
  - The pop-up overlay shows 1 → 2 → 3 popups at 1.0 s, 2.0 s and 3.5 s over the SBS video.
- **Pack in VR.** 1/5 SBS video (stereo, 86 fps) → 2/5 TB → 3/5 3D stills → 4/5 and 5/5 mono images → end static card.
  - The mono items and the card switch to the 2048² mono map with the eye meshes hidden.
  - Stepping back switches mono → stereo again.

**Parallax check (objective depth geometry).** This checks that the headset renders the parallax the author put in the file. It does not judge felt depth.
- **Method.**
  - Take a `screencap` of the eye buffers (3664×1920, left and right halves) while a natural-footage 3D post plays, and find the source frame it shows.
  - Fit a SIFT + CLAHE homography per eye from the source half to the eye buffer.
  - Match features between the two eyes, map them back into source space, and compare the rendered left-to-right disparity with the authored one.
- **Samples.**
  - SBS video, 4 captures of one frame.
  - TB clip (made from the same footage), 13 captures of two frames.
  - The screencap freezes on one frame per session, so this is 3 distinct frames in all.
- **Result: all three pass.**
  - Rendered disparity equals authored disparity. Slope is 0.97–1.01 for TB frame f050, and about 1.0 for SBS and for TB frame f103.
  - The median error is under 1 px of source resolution, and the vertical misalignment is under 1.5 px (0.5–0.7 px on f050).
  - Eye order is correct. With the right eye sampled as the left, agreement drops to about 3–7% for TB f050 (correct order: 78–90%) and about 4% for SBS (correct order: 43–65%). The chance baseline is about 25%. A swapped-eye check on TB f103 sat between 0% and 35%, against 82–95% correct.
- **Comfort geometry** (screen scale 4, so about 4 m wide at about 2.24 m, about 2.08 mm per source pixel, IPD assumed 63 mm).
  - All authored parallax is crossed, so content sits in front of the screen and nothing diverges.
  - Median parallax is about 12–15 px (about 26 mm), which puts content at about 1.6 m.
  - The 95th percentile is about 50 px (about 104 mm), about 2.6% of the image width, at about 0.85 m.
  - These extremes come from the lightbike footage, not from the renderer. A close pop-out like this is where a person is most likely to feel eye strain.

**Not verified on the device.**
- **Perceived depth and comfort.** The parallax geometry is verified above, but felt depth, fusion and eye strain need a person in the headset.
- **Earth hover preview card.** With nobody holding it, a tracked controller's ray still resets the hover every frame, so the card cannot be driven over CDP. It uses mono assets only and passed in the emulated XR run.

**Observations.**
- **One transient slowdown, not reproduced.**
  - Early in the session, right after a burst of CDP canvas readbacks and screencaps, XR ran at 11–19 fps for about a minute, with about 9 uploads/s.
  - It did not recur in 14 later runs, including the same Earth → location-feed sequence.
  - The battery was at about 8% and charging at the time. Watch for stutter during the hands-on check.
- **Quest `screencap` can return a stale frame for minutes during WebXR.** It returned identical pixels while the app showed other content, and an in-page read of the stereo canvas confirmed the app was correct. Only trust a capture that differs from the previous one or shows new content.
- **Detection.** The tinted TB sample scored 0.69, below the 0.72 threshold, which is expected with a different tint per eye. It was published with an explicit `tb`.
- **Pack mode stays on AUTO.** The mode toggle does not apply there; this is existing behaviour.

### Earth hover dwell (2026-10-16)

**Earth hover dwell (engine `v8.22-20261016-earth-preview-dwell`).** An uncached zone must be rested on for 200 ms (`EARTH_PREVIEW_FETCH_DWELL_MS`) before its first preview request, so sweeping across N zones sends none. The check is driven per frame from `updateEarthHoverFromRay` and the Earth frame update, using `earthPreviewHoverSince`; there are no timers. Cached zones still apply synchronously, an in-flight request is still shared without waiting, and the 30 s cache, once-per-departure panel grace and 5 s failure hold are unchanged. Covered in `web/tests/webxr-earth.test.js`: a sweep of 5 zones shorter than the dwell makes 0 requests, resting past the dwell makes 1, and a cached zone shows immediately.

Emulator check of the dwell (isolated backend :8011 with a copied DB, Vite :5184, Chrome + Immersive Web Emulator, `controlMode = 'programmatic'`, reduced motion on so the globe holds still, Earth opened in a real `immersive-vr` session). Request counts come from the backend access log (`GET /api/reels/locations/<slug>`, excluding `/activity`), not from a `window.fetch` wrapper:
- **(b) Sweep across zones:** 5 zones at 120 ms each, then again in reverse at 150 ms each: 5 zones seen, 0 requests.
- **(c) Rest on one zone:** resting on Lagos for 3 s: 1 request, sent 208 ms after the ray landed; none after. Paris behaved the same (1 request at 211 ms).
- **(a) Ray on the WORLD title label after a hover:** after 700 ms on Paris (the 1 request above), 3 s resting on the label sent 0 more. To reproduce the old panel ↔ bare-globe flip, one controller was held on the label and the other on bare globe after a 100 ms hover on Manchester: the hover changed 4 times in 3.1 s (the grace restored the zone once) and 0 requests were sent, against about 120 per second before the cache fix.

**Emulator quirk, for anyone repeating this.** The emulator delivers two XR frame callbacks per device frame (`onDeviceFrame` and a second one). The engine's laser reads the right controller in the first and the left controller in the second, so both controllers must be aimed at the same zone, each from its own origin. With only one controller aimed, the hover flips between two zones every frame and the dwell never completes. The `window.fetch` wrapper from the earlier QA missed the host's preview requests here, so use the server log.

`make test` passed on `3dreels` after this change was merged (with the `exitVR` fix, engine `v8.23-20261016-exit-vr-awaits-end`): pytest 347, node 337, vitest 353.

### Top-bottom fixture check (2026-10-18)

`scripts/dev/experiment_stereo_tb.py` restacks the real SBS clips in `output/testpipeline-3d` as top-bottom (left eye on top) and runs the detector. Each eye has a corner marker: red on the left eye, blue on the right eye. That makes it possible to check which eye a 2D rendition or a VR eye shows. Fixtures and `results.md` go to `reports/stereo-tb/`.

| Fixture | Size | Codec | Detected | Method | Score |
|---|---|---|---|---|---|
| tb-weeknd-1920-h264.mp4 | 1920×3840 | H.264 | tb | content | 0.853 |
| tb-tron-2160-hevc.mp4 | 2160×4320 | HEVC | tb | content | 0.921 |
| tb-projectx-1024-meta.webm | 1024×2048 | VP9 | tb | metadata (`stereo_mode=top_bottom`) | — |
| tb-tron-2048-still.png | 2048×4096 | PNG | tb | content | 0.833 |
| neg-tb-duplicate.mp4 | 1920×3840 | H.264 | no | no_parallax | 0.989 |
| neg-tb-two-clips.mp4 | 1920×3840 | H.264 | no | — | 0.000 |
| neg-tb-inverted-meta.webm | 1024×2048 | VP9 | no | inverted (`bottom_top`) | — |

Upload API (`/api/video/upload`, `/api/image/upload`) returns the same `stereo` results. The four positives were published as `tb` posts by the local test account `seed3d_tb`. The background build then produced:
- **2D renditions:** 1920², 2160², 1024² MP4 and a 2048² PNG. The `-mono-explore` clips are 720², and the posters 720² JPG. Every rendition and poster has the red marker, so the 2D view is always the left (top) eye.
- **Stereo proxies:** the HEVC original gets a 2048×4096 H.264 `-preview.mp4` (long side capped at `STEREO_PROXY_LONG_SIDE` = 4096), and the WebM gets a 1024×2048 H.264 proxy. The 1920×3840 H.264 original is under the cap and is served as-is.
- **Feed:** `media=stereo` lists all five TB posts (with the Tron seed), each with `stereo_crop` false. In the browser each one plays as a 1:1 left-eye rendition with the "3D · TOP-BOTTOM" badge.

Found during the check: the backend had been started before the no-parallax guard landed, so the duplicate negative was still marked detected at upload until uvicorn was restarted. After a backend edit, restart uvicorn (it runs without `--reload`).

**Quest 3S (Browser, CDP).** Each TB post was opened from `/reels?post=<id>&folder=ALL+FOLDERS&codec=all&media=stereo` and entered in VR. A probe then read `WebXRVR.__test.getStereoState()`. It also sampled the stereo canvas at the marker position of each eye, mapped through that eye texture's `repeat`/`offset`. The probe finds the canvas by hooking `drawImage` on a 1:2 canvas.

| Post | Plays from | `textureStereo` | Canvas | Left eye (offset → marker) | Right eye (offset → marker) | Chip |
|---|---|---|---|---|---|---|
| H.264 1920/eye | original | tb | 2048×4096 | [0, 0.5] → red | [0, 0] → blue | 3D TB |
| HEVC 2160/eye | `-preview.mp4` | tb | 2048×4096 | [0, 0.5] → red | [0, 0] → blue | 3D TB |
| WebM `stereo_mode` | `-preview.mp4` | tb | 2048×4096 | [0, 0.5] → red | [0, 0] → blue | 3D TB |
| PNG still | original | tb | 2048×4096 | [0, 0.5] → red | [0, 0] → blue | 3D TB |

On every post:
- Both eyes have `repeat` [1, 0.5], their own eye texture (`mapIsEye`), and are visible on layers 1 and 2.
- `screenShowsLeftEye` is true.

So the left eye sees the top half and the right eye sees the bottom half, for video and still alike. The probe output and the chip captures are in `reports/stereo-tb/quest-*`.

Probe notes:
- A 5 s clip ends and advances to the next reel before a slow probe can set `loop`. Arm the loop as soon as `#reelsVideo` shows the target file.
- After the headset reconnects, re-run `adb reverse tcp:5173 tcp:5173` and `adb reverse tcp:8000 tcp:8000`. Otherwise the page shows `ERR_CONNECTION_REFUSED`.
