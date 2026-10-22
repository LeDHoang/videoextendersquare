# Stereo 3D reels — remaining fix plan

Follow-up to the 2026-10-18 review of branch `3dreels`. Spec: [stereo-3d-reels.md](stereo-3d-reels.md).

## Fixed first (`c3ebf8a`)

These were fixed on the `fix/stereo-review` branch and merged into `3dreels` in `c3ebf8a`.

| # | Bug | Where |
|---|---|---|
| 1 | Eye textures are `base.clone()` and flagged for upload once, so stereo video in XR likely freezes on its first frame | `ui/assets/webxr_vr.js` `ensureEyeTextures` / `uploadVideoFrame` |
| 2 | The `loadedmetadata` resume listener in `syncStereoSource` seeks without checking the src, so a swipe during the swap starts the next reel at the wrong time | `ui/assets/reels.html` |
| 3 | VR180/360 files are not rejected | `pipeline/stereo_detect.py` |
| 4 | Inverted (right-eye-first) metadata falls through to the content pass | `pipeline/stereo_detect.py` |
| 5 | Rotation and EXIF orientation are ignored when classifying and cropping | `server/media.py`, `pipeline/utils.py`, `server/routers/uploads.py` |


## Phase 0 — confirm bug 1 on the Quest (gate)

Bug 1 was reproduced in three.js r186 but never seen in the headset. Check it on the device, once before the fix lands and once after. Solid-colour test clips hide this bug, so use a moving clip.

1. Connect over USB and keep the headset awake with `adb shell am broadcast -a com.oculus.vrpowermanager.prox_close`, as in the on-device QA section of the spec.
2. Run `adb reverse tcp:8000 tcp:8000` and `adb reverse tcp:5173 tcp:5173`.
3. Open `http://localhost:5173/reels?post=7a68881a-3130-5e1d-acad-4b001004ddf4` (Tron) in Quest Browser.
4. Run `adb forward tcp:9222 localabstract:chrome_devtools_remote` and attach with `scripts/debug-quest-targets.cjs`.
5. Enter XR: `Runtime.evaluate` `#vrBtn.click()` with `userGesture: true`. Tap Allow on the immersive prompt with `adb shell input tap`.
6. Sample `WebXRVR.__test.readCenterPixels()` 10 times, 500 ms apart, alongside `video.currentTime`.
7. Pass: the samples change while `currentTime` advances. Fail: the samples stay identical, which means the frame is frozen.
8. Record the results in the spec's on-device section.

**Baseline result, 2026-10-18, branch `3dreels` at a693708, before the fix: FAIL, bug 1 confirmed on the Quest 3S.**

- Setup: the SBS feed (`?folder=testpipeline-3d`), in XR on its 4096×2048 `-preview.mp4`. Engine state matched the spec: `textureStereo: sbs`, L offset (0,0), R offset (0.5,0), repeat (0.5,1), and `mapIsEye` true.
- Measurement: the `texImage2D` / `texSubImage2D` methods on the WebGL prototypes were hooked over CDP for 4 s while the video played (`currentTime` 1.62 to 5.62).
- Result: 6,146 draw calls and 48 uploads of the 1024×384 HUD canvas, but **0 uploads of the 4096×2048 stereo canvas**. The eye textures are never re-uploaded, so each eye shows a frozen frame.
- `readCenterPixels` returns black while in XR, because it reads the default framebuffer and not the XR layer. It is not a valid check during a session, so use the upload count instead.
- After the fix, the same probe should show about 30 4096×2048 uploads per second (the upload cap).
- **After the fix, 2026-10-18 (the `fix/stereo-review` worktree diff applied uncommitted): PASS.** Same probe, video at 1.64 to 5.65 s: **158 uploads of the 4096×2048 stereo canvas** in 4 s and 4,540 draw calls. `getStereoState().left.version` went from 107 to 269 in about 5 s, roughly 30 bumps per second, which matches the upload cap.
- No double upload. A steady 5 s window gave 154 uploads at 4096×2048 for 154 L and 154 R version bumps, which is **1.00 upload per bump at 30.8/s**. Both eye copies share one GL texture through three.js's source cache. The earlier figure of about 40/s came from the seek and restart at the start of that probe.
- Side finding: `/reels?post=<id>` did not open the requested post on the Quest; the Ukraine drone post loaded instead of Tron. This matches the `?play=` failure seen on desktop. Add it to Phase 2.

Add a `__test.getStereoState()` field that reports `L.version`, `R.version` and `base.version`. That turns this check into a single CDP read.

## Phase 1 — backend robustness

Status, 2026-10-18: all done except 1.6, which needs no change. Tests are in `tests/test_stereo_posts.py` and `tests/test_migration_stereo_layout.py`.

| Item | Change | Test |
|---|---|---|
| 1.1 Synchronous stereo work in the publish request | Move `make_left_eye_rendition` and the video `detect_stereo` pass onto the existing background job path. Until the 2D rendition exists, the post serves `stereo_crop=True`, which already falls back to CSS crop. | Publishing a stereo video returns before the encode. The feed shows `stereo_crop` and then switches to the rendition. |
| 1.2 Oversized old proxies served as `stereo_url` | `stereo_paths` probes the proxy size and skips any proxy whose long side is over 4096, falling back to the original. `batch_stereo_mono.py --rebuild-proxies` regenerates them. | A unit test with a 4320×2160 proxy fixture. |
| 1.3 Batch is not idempotent | `batch_stereo_mono.py` checks each derived asset (`-mono`, `-mono-explore`, `-mono-poster`, `-preview`) separately and makes only the missing ones. Confirm soft-deleted posts are excluded. | Delete one asset, rerun, and only that asset is rebuilt. |
| 1.4 Legacy import uses the folder rule only | `legacy_stereo_layout` and the loose-file path in `_build_payload` also require an exact 2:1 / 1:2 ratio, the same rule as migration 0013. | A non-2:1 file under `testpipeline-3d/` stays mono. |
| 1.5 Grid assets when there is no 2D rendition | When `stereo_crop` is True, `_gen_explore_assets` builds the poster and explore clip from the left eye (reusing `_left_eye_crop`) and not the full SBS frame. | Grid tiles stay square before the backfill runs. |
| 1.6 Orphaned files after delete | **N/A.** There is no purge path: `delete_post` only soft-deletes and keeps the media, so no sibling is orphaned. Revisit if a hard delete is added. | — |
| 1.7 Migration downgrade | Add a downgrade test for `20261015_0013`. | upgrade, downgrade, upgrade on SQLite, and on PostgreSQL when `SX_TEST_POSTGRES_URL` is set. |

## Phase 2 — frontend and VR polish

Status, 2026-10-18: all done. 2.8 landed later the same day (spec updated first; see below). 2.9 was not a bug. Node tests are in `web/tests/reels-stereo.test.js`; vitest in `UploadPage.test.jsx`, `PackTile.test.jsx` and `ExploreTile.test.jsx`.

| Item | Change | Test |
|---|---|---|
| 2.1 Double `syncStereoSource` on VR entry | Keep one call site, the `onEnterVR` callback, and drop the duplicate near `reels.html:~6999`. | A node test counts swaps per entry. |
| 2.2 `stereoFailed` is sticky | Retry once after 5 s, then fall back to 2D and show a short "3D unavailable" toast. Clear the flag when the user navigates away from the post. | The stereo file 404s once and succeeds on retry. A permanent 404 falls back to 2D. |
| 2.3 Preloader warms only one variant | After a VR enter or exit, re-warm the next item for the new state. | Unit test on `preloadNext` after a state flip. |
| 2.4 Upload 3D override is stale | Reset `stereoOn` whenever `stereoChoice` becomes null or the gallery changes identity. | Vitest: toggle on, add a mono image, remove it, and 3D stays off. |
| 2.5 Pack tile crop | `posterClass` uses the format of the member the cover actually comes from. | Vitest with a mixed pack. |
| 2.6 a11y | Add "3D" to the explore and profile tile `aria-label`. | Vitest. |
| 2.7 Resume on VR entry | Respect the paused state on VR entry, as the spec already notes (`webxr_vr.js:9315`). | Node test plus a Quest check. |
| 2.9 Deep links miss the target | **Not a bug.** The API returns the requested post first, and both `?post=` and `?play=` land on it on desktop and on the Quest (Tron `-mono.mp4` held for 12 s). The earlier mismatch was the 15 s Tron clip auto-advancing before the probe read the src. | Quest check passed. |
| 2.8 In-headset 3D indicator | Done. The dock draws an accent "3D SBS" / "3D TB" chip after the title (`vr_ui_canvas.js`, `STEREO_CHIP`). It follows what is on screen (`textureStereo` with live eye textures), not the post field. Spec: "3D chip" in `stereo-3d-reels.md`. | Dock canvas captured on the Quest for the TB seed and Tron: "3D TB" / "3D SBS". |

## Results, 2026-10-18

Backend:
- 1.1: a stereo video publish returns after the poster. The rendition, the proxy and the mono grid assets are built on one background worker, with atomic `.part` writes.
- 1.2: an oversized cached proxy is skipped on read.
- 1.3: the batch script rebuilds only missing assets.
- 1.4: the legacy folder rule needs exact 2:1.
- 1.5: grid assets crop the left eye before the rendition exists.
- 1.7: the migration round trip runs on SQLite. On PostgreSQL it runs when `SX_TEST_POSTGRES_URL` is set.

Frontend:
- 2.1: one swap per VR entry.
- 2.2: the stereo retry, then the 2D fallback.
- 2.3: an image-post VR switch re-warms the preloader.
- 2.4: the 3D switch no longer carries across slideshow edits.
- 2.5: the pack cover is cropped by its real source member.
- 2.6: the "(3D)" aria-label.
- 2.7: VR entry keeps the paused state.
- The VR callbacks are now wrapped (`() => syncStereoSource()`), so an engine argument can never reach the swap.

`make test`: 366 pytest passed (1 PostgreSQL skip), 348 node passed, 360 vitest passed.

Quest 3S checks over CDP (Tron, `?post=`):
- **2.7.** Paused at 9.99 s and entered VR. The video stayed paused on `-preview.mp4` at 9.99 s for 6 s. After exit it was back on `-mono.mp4` at 9.99 s, still paused.
- **2.2, transient.** The CDP `Fetch` domain 404'd the first `-preview.mp4` request. The view fell back to 2D at the same playhead (3.5 to 4.3 s) and switched back to stereo at about 5 s (8.8 s). No notice was shown.
- **2.2, permanent.** Every `-preview.mp4` request 404'd: 2 tries, then it stayed on 2D at the same playhead and flashed "3D UNAVAILABLE — SHOWING 2D". The first build of this fix restarted the 2D fallback at 0, because a failed load reports `currentTime` 0. The fallback now resumes from the last swap's playhead.
- **Bug 2 (swipe during the swap).** Tron was playing at 6 s. ArrowDown was sent while the stereo swap was still at `readyState` 0, and the next reel started at 0.00.

## Phase 3 — tests and docs

Status, 2026-10-18:
- `npm test` already runs `node --test tests/*.test.js && vitest run`, and `make test` calls it, so the node suites are wired.
- The swipe-during-swap and 404-fallback regression tests are in `web/tests/reels-stereo.test.js`. The eye texture version check is in `webxr-earth.test.js` from `c3ebf8a`.
- The rendition-size drift is not real: the spec table already says "at most 2160²". The 1920² figures in the log are measured from 3840×1920 sources, whose eyes are 1920².
- The batch warning is already documented in the spec.
- The new behaviour (async publish, retry, paused entry, proxy cap on read) is recorded in the spec's Notes section.
- TB seed done. "Tron lightbike (3D TB)" (post `7c57853a-1be0-4ebd-9122-8b62de895a95`, 1920×3840, built from the Tron SBS clip) was published by the local test account `seed3d_tb` (credentials in the gitignored `logs/test-account-seed3d.txt`). Upload detection: tb, content, 0.872. On the Quest it enters VR with `textureStereo` tb, eye repeat [1, 0.5], top half to the left eye, and the "3D TB" chip.
- TB fixture check done. `scripts/dev/experiment_stereo_tb.py` builds marked TB fixtures in four formats: H.264, HEVC, WebM with `stereo_mode`, and a PNG still. It also builds three negatives. All seven are detected correctly. The four positives were published, and their 2D renditions show the left eye. On the Quest, the left eye samples the top-eye marker and the right eye samples the bottom-eye marker. Results are in the spec's "Top-bottom fixture check" section.

- Wire `node --test web/tests/*.test.js` into `npm test`, or confirm it already is. The review found vitest `include` only covers `src/**`.
- Add the missing regression tests from the review that the earlier phases don't already cover: a swipe during the swap, a 404 falling back to 2D, and an eye texture version advancing per frame.
- Fix the spec drift: the 2D rendition is 2160², not 1920². Document that batch upload warns about 3D files but has no stereo path.
- Seed at least one TB post. There are 0 today, so TB can't be checked live.

## Phase 4 — product questions (decided 2026-10-18)

- Non-square SBS eyes (3840×1080, 1920×540): not supported. Product decision: square eyes only.
- Detection threshold: calibrated with `scripts/dev/experiment_stereo_threshold.py` against split-screen edits. Different clips, mirrored, zoomed and time-offset halves all scored below 0.72. Identical and colour-graded copies scored 0.83–0.98 and were detected. A no-parallax guard now rejects them (best shift 0 in every frame, method `no_parallax`). Real SBS still scores 0.81–0.93 and is detected. The threshold stays at 0.72; numbers are in the spec's Detection section.
- Feed discoverability: the in-headset 3D chip is the 2.8 label. A "3D" button on the Reels filter rail (`media=stereo`) is added for testing only; it keeps stereo posts and legacy `testpipeline-3d` 2:1 files.

## Phase 5 — final on-device QA (Quest 3S)

Use the same setup as Phase 0. Do the checks in this order:

1. Tron: video moves in both eyes (bug 1), L/R are correct, and `getLastRenderError` is null.
2. Pause at about 3 s and exit VR. The 2D view keeps the playhead and stays paused. Enter again, and it stays paused (2.7).
3. Swipe to the next item while the stereo swap is still loading. The new reel starts at 0 (bug 2).
4. Step through all 6 SBS posts and the seeded TB post, checking frame pacing with `getVideoPlaybackQuality` (0 dropped).
5. A person in the headset judges perceived depth and comfort. This is the only item that can't be automated.

Don't take screencaps while in XR (they can return stale frames). Use the `readCenterPixels` CDP readback instead.
