# Manual beta checks

Run these checks on the **real HTTPS domain through the Cloudflare Tunnel**, after `docs/deploy-runbook.md` §1–2 are done and before inviting users. They cover what automated tests cannot: two real browsers, Cloudflare's edge, and a Quest headset. Record the date, the commit (`GIT_SHA`) and who ran them in `docs/to-beta.md` (P0 manual checks).

Placeholders: `<domain>` is the app origin and `media.<domain>` the R2 public host. `<key>` is the object path of a published reel. To find it, copy the video URL from the post in DevTools → Network.

## 1. CORS and cache at the edge

These checks prove the Transform Rule and bucket CORS make every cached copy CORS-safe, whatever request filled the cache first. Use a freshly published reel, so its URL has not been cached yet.

```bash
M=https://media.<domain>/<key>
O=https://<domain>

# A. Plain request first (what a React <video> sends: no Origin)
curl -sI "$M" | grep -iE '^(HTTP|access-control|cf-cache-status|content-type)'
# B. Then a CORS range request (what WebXR sends)
curl -sI -H "Origin: $O" -H "Range: bytes=0-1" "$M" \
  | grep -iE '^(HTTP|access-control|content-range|accept-ranges|cf-cache-status)'
```

- [ ] A returns `200`, and `access-control-allow-origin: https://<domain>` is present even without an Origin header (from the Transform Rule).
- [ ] B returns `206`, `access-control-allow-origin: https://<domain>` and `content-range: bytes 0-1/<size>`.
- [ ] B shows `cf-cache-status: HIT`. Run B again if the first try shows `MISS`.
- [ ] Repeat with the **order reversed** (B, then A) on another fresh reel. Both requests still carry ACAO, and the second one is a `HIT`.
- [ ] `curl -sI https://<domain>/api/readyz` shows `cf-cache-status: DYNAMIC` or `BYPASS`, never `HIT`.
- [ ] A map tile, `curl -sI https://<domain>/api/reels/map-tiles/<z>/<x>/<y>` (copy a real path from DevTools), reaches `HIT` on the second request.

## 2. Two-browser pass

Use two invited accounts, **A** and **B**. Run each in its own browser profile or private window, so cookies do not mix.

- [ ] **Signup.** A and B each sign up with an invited email.
  - The Terms checkbox is required.
  - A non-invited email is refused while `SX_REGISTRATION_ENABLED=0`.
- [ ] **Session.** Reload. Both stay signed in, and cookies are `Secure` (DevTools → Application → Cookies).
- [ ] **Publish.** A uploads a short video, runs a job and publishes a reel.
  - The video and poster URLs are on `media.<domain>`.
  - B sees the reel in the feed, and it plays and seeks.
- [ ] **Avatar.** A sets an avatar, and it renders for B.
- [ ] **DM.** B sends A a direct message, then A replies.
  - Both sides update.
  - A reload still shows the decrypted history.
- [ ] **Report.** B reports A's reel, and the report appears in the admin or moderator queue.
- [ ] **Delete.** A deletes the reel.
  - It disappears from B's feed.
  - `curl -sI https://media.<domain>/<key>` returns `404`. A cached copy may persist for up to 1 day; purge-by-URL clears it (`docs/deploy-runbook.md` §5).
- [ ] **Origin check.** Every mutating request in DevTools succeeds with no `403 ORIGIN_DENIED`. That error means the Tunnel is rewriting `Host`.

## 3. Quest smoke test (Meta Quest Browser)

Open `https://<domain>` on the headset through the Tunnel, not on a LAN IP, and sign in as A. Connect the headset to a desktop Chrome with `chrome://inspect` to watch the console and network.

- [ ] **VR notice.**
  - Entering VR shows the notice **once**, and **Continue** starts the immersive session.
  - On a second entry in the same browser, the notice does not show again.
- [ ] **Mono reel.** A mono reel plays in VR, and seeking (scrub forward and back) works.
  - Its requests go to `media.<domain>`, with `206` responses.
- [ ] **Stereo reel.** A stereo (SBS) reel plays with correct per-eye separation, and seeking works.
- [ ] **MAKE 3D comfort** (only where `SX_STEREO_CONVERT_ENABLED` is on). Publish one converted video and one converted image from Upload Studio. Each needs a person, with no device tool in the loop.
  - The background reads as behind the frame and the nearest subject slightly in front of it. Near objects do not double or shimmer, and nothing at the left or right frame edge looks cut off.
  - Silhouettes stay clean: no stretched rubber edges at hair, hands or object borders.
  - Depth does not pump or swim within a shot, and it settles at once after a scene cut.
  - Viewing for a minute causes no eye strain. Compare against a native SBS reel.
- [ ] **No WebGL taint.** The console shows no `SecurityError`, `tainted`, `cross-origin` or `texImage2D` errors, and no reel renders as a black quad.
- [ ] **No diagnostics traffic.** The Network tab shows **no** requests to `/api/reels/diag`, because diagnostics are off in production.
- [ ] **Exit and re-enter.** Exiting VR returns to the 2D page, and re-entering works without a reload.
