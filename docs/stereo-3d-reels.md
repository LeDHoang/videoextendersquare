# 3D Reels — stereoscopic SBS + top-bottom posts

Branch: `3dreels` (cut from `origin/main` @ `dcaa4e4`). Status: **implemented; on-device Quest check pending**.
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
   - Calibration: six real 7680×3840 SBS reels in `output/testpipeline-3d` scored 0.81–0.98. Ordinary 2:1 and 1:2 crops and stretches scored 0.00–0.33, and a synthetic test pattern scored 0.64.
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

## Limits / not supported

- **Not supported:**
  - half-SBS and half-TB;
  - inverted layouts (right-left, bottom-top);
  - Apple MV-HEVC spatial video;
  - 180°/360° projections.
- **Stereo publish restrictions:**
  - It must use the as-is path (`stage_id`). Extended (`job_id`) outputs are always mono.
  - Every slide in a stereo slideshow must share the same layout geometry.
- **The layout cannot be edited after publish.**

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
- [~] **Verification:** `make test`; browser checks for upload, 2D, grids and the split-stereo preview; the IWER emulator flows; on-device Quest checks for depth, swap, frame pacing and the TB proxy decode.

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
