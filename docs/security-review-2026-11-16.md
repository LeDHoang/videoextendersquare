# Security review, 2026-11-16

Scope: the source at `1fc4040` (branch `private-posts`) and the production site `https://echomultiverse.com`, reviewed for the open beta. No source file was changed.

**Do not push this file to the public repository before finding 1 is fixed and deployed.** It describes how any signed-in user can break the player on production.

## Baseline

- Production runs `73d8427` (the checkout in `/opt/echo` on the VPS, branch `main`, merged 2026-11-15), schema `20261114_0025`. Findings 1 to 4 are in the code at that commit.
- Live probes: signed out (GET requests, one cross-origin POST, one password-reset request for an address that has no account) and signed in as a normal test account (see "Signed-in flows on production"). Nothing was changed on the site.
- The VPS was read over SSH with read-only commands. From the `.env`, only flag values, the presence and length of secrets, and the number and kind of entries in the role lists were read. No secret value was printed.
- The repository is public on GitHub.

Each finding is tagged: **reproduced** (run locally in this review), **code** (read from the source, not run), or **measured** (seen on production).

## Result

No critical hole was found. Four findings are in the code that production runs now. One more is on the `private-posts` branch only.

Fix status (2026-11-16): findings 1 to 3 are fixed on the branch `security-fixes` (off `private-posts`), not merged and not deployed. Production still runs `73d8427` without the fixes. Finding 4 is deferred by the owner. Finding 5 is fixed on `private-posts` (`dd3233d`).

## Findings to fix before the open beta grows

### 1. Any user can break the player for other viewers (production, reproduced)

- Where: `server/routers/reels.py:3191-3192` (`/player`) and `:3510-3511` (`/player-inline`); template `ui/assets/reels.html:2586-2587`.
- What: the page is built with two chained calls, `html.replace("__VIDEO_DATA_JSON__", ...)` and then `html.replace("__FEED_STATE_JSON__", ...)`. The second call also runs over the data that the first one inserted. If a title, caption or display name in the first payload contains the literal text `__FEED_STATE_JSON__`, the feed JSON is spliced into the middle of a JavaScript string.
- Effect: the inline script fails with a `SyntaxError`, and the player does not start for every viewer whose page holds that post. Reproduced with node on the same replace chain. Not tried on production.
- Limits: no path to script execution was found. The spliced text always follows a closed string, so the script fails to parse and does not run. `_json_for_script` (`reels.py:3090`) escapes `</`. The CSP on production is report-only, so there is no second barrier.
- Class: availability. A stored value breaks pages for other users.
- Fix: substitute both placeholders in one pass (one `re.sub` with a lookup), and escape `<`, `>` and `&` as `<`, `>` and `&`, and U+2028 and U+2029, in `_json_for_script`.
- Deploy the fix soon after the commit lands. The commit itself shows the trick.
- Status: fixed in `65f6004` (`security-fixes`). `_fill_player_data` fills the two data slots and the start index in one pass, so inserted data is never substituted again. `_json_for_script` escapes `<`, `>` and `&`; `json.dumps` already escapes U+2028 and U+2029. Test: `tests/test_player_data.py` (a title with both placeholder names, `</script>`, `<!--`, `&` and U+2028 comes back unchanged from `/api/reels/player` and `/api/reels/player-inline`). Not deployed.

### 2. Reset and verification tokens can be returned in HTTP responses (production code, depends on the env)

- Where: `server/routers/account_safety.py:331`, `server/routers/social.py:500`; no check in `production_config_errors()` (`server/settings.py`).
- What: with `SX_PASSWORD_RESET_EXPOSE_TOKEN=1` the password-reset request and the registration response carry the token as `debug_token`.
- Effect: with the flag on, anyone can take over any account from its email address or username.
- State (measured 2026-11-16): the VPS `.env` has `SX_PASSWORD_RESET_EXPOSE_TOKEN=0`, and a live reset request returned no `debug_token`. Not exploitable now. The code does not enforce it.
- Fix: make the app refuse to start in production when the flag is set.
- Status: fixed in `f54d710`. `production_config_errors()` rejects `SX_PASSWORD_RESET_EXPOSE_TOKEN=1`. Test: `tests/test_settings.py::test_rejects_tokens_exposed_in_responses`. The production and SIT `.env` files both have `0`, so both still start.

### 3. The admin role can be claimed by username (production code, depends on the env)

- Where: `configured_role`, `server/routers/social.py:145-157`.
- What: `SX_ADMIN_USERS` and `SX_MODERATOR_USERS` match by username or by email. A listed username that is not registered yet can be registered by anyone. A listed username also becomes free when its account is deleted, because deletion replaces the username with a tombstone (`server/routers/account_safety.py:1125-1128`). The role is granted when the email is verified.
- Effect: whoever registers that username becomes admin or moderator.
- State (measured 2026-11-16): both variables are empty in the VPS `.env`, so not exploitable now. The database has 1 admin and 26 users. The risk starts when a username is added to either list.
- Fix: accept email addresses only, which are verified at sign-up. Until then, list emails only.
- Status: fixed in `6b67d64`. `configured_role` takes the email only; a username in either list matches nobody. Test: `tests/test_security_edge.py::test_staff_lists_match_email_only`. The env examples and `RUNNING.md` now say emails. Production lists are empty and the one SIT entry is an email, so no env change is needed.

### 4. As-is uploads keep GPS and device metadata (production code, reproduced on the functions)

- Where: publish copies the bytes with `shutil.copy2` (`server/routers/uploads.py`); `make_faststart` keeps metadata with `-map_metadata 0` (`server/media.py:311`).
- What: a photo or video published without processing keeps its EXIF GPS block or its MP4 location tag. The file is served from a public media URL.
- Evidence: reproduced on the copy step and on `make_faststart` with test files that carry GPS. The publish route itself was not run. On production, 8 images and 8 videos sampled from the feed carried no EXIF, GPS, location or device tags.
- This is already an open item in `docs/to-beta.md` (Privacy completeness). It conflicts with the city-level location floor.
- Fix: strip metadata at publish (`-map_metadata -1` for video; save images again without EXIF).
- Status: not fixed. Deferred by the owner on 2026-11-16. The Privacy page (`web/src/pages/PrivacyPage.jsx:66-69`) tells users that the original file is shared as uploaded and that they should remove location data first.
- Notes for the fix, from a trial on 2026-11-16:
  - Video: `-map_metadata -1` alone is not enough. Location can also sit in data tracks, so map the video and audio streams only (`-map 0:V -map 0:a?`), and remux every MP4, M4V and MOV, not only those with the index at the end as `make_faststart` does now. Rotation stays with a stream copy.
  - Stills: saving again with Pillow 12.3 keeps a JPEG comment, changes the pixels, turns a 16-bit PNG into 8-bit and keeps only the first frame of an animated WebP. Dropping the metadata blocks from the container changes no pixel. Keep the orientation tag and the ICC profile.
  - A file that cannot be rewritten must be refused, or it is published with its location. `tests/test_publish_background.py` and `tests/test_batch_vr2k.py` publish filler bytes through a fake ffmpeg and need that step switched off.
  - Not solved by a fix at publish: files already published, AVI and WebM.

### 5. A private post can be added to another user's public pack (branch only, code)

- Where: `server/routers/packs.py` (`active_item`, `member_available_for_viewer`, `validate_posts`) has no rule for `Post.visibility`.
- What: a user who knows the id of a private post can add it to their own pack, and the pack shows it.
- Reviewed and sound in `1fc4040`: post ids are UUIDv4, so links cannot be guessed by counting; the creator's own scope is decided on the server from the session; a link lifts only the private rule, so removed posts, blocked users and inactive owners stay hidden.
- By design a private post is unlisted, not locked: its media stays at a public URL and anyone with the link can open it. The UI should say that ("Unlisted", or "Anyone with the link can see this").
- Fix: land the pack rule before the branch is deployed.
- Status: fixed in `dd3233d` (`private-posts`, read 2026-11-16). `validate_posts` refuses a private post that the pack owner does not own, and a private member shows only to viewers of its owner's own unlisted pack. Tests: `tests/test_reel_packs.py` (`test_only_the_owner_adds_a_private_post_to_a_pack` and the three next to it). Read in the code; the tests ran in the full suite.

## Production site

Measured on 2026-11-16, signed out.

- **CSP is report-only** (`content-security-policy-report-only`; `SX_CSP_MODE=report` in the VPS `.env`). The app log holds 0 `csp-report` lines, but the container was recreated 23 hours earlier, so that covers one day. Enforce it after finding 1 is fixed. Already an open item in `docs/to-beta.md`.
- **HSTS is 30 days** (`max-age=2592000`), with no `includeSubDomains`. Raise it once both hosts are stable.
- **`/api/health` and `/api/readyz` answer anyone.** `/api/health` returns the ffmpeg version, the encoder, total and used RAM, and `fal_key: set`. `/api/readyz` returns the schema revision and free disk. Reduce the public body to a status, and keep the detail behind `/api/ops/*`.
- **Mail DNS.** SPF (`send.mail.echomultiverse.com`) and DKIM (`resend._domainkey.mail.echomultiverse.com`) are present for Resend. DMARC is `p=none`, so a forged message from the domain is not rejected. Moving to `p=quarantine` is already an open item. There is no CAA record and no DNSSEC.
- **`sit.echomultiverse.com` is reachable by anyone.** It sends `X-Robots-Tag: noindex`, has no Turnstile and no access gate. The template sets registration off with an allowlist. Put Cloudflare Access in front of it.
- **No `robots.txt` and no `/.well-known/security.txt`.** Both paths return the SPA shell with status 200.
- **Correct:** HTTP redirects to HTTPS; `/docs`, `/redoc`, `/openapi.json`, `/.env` and `/.git/config` return the SPA shell and no real file; `/media/`, `/avatars/`, `/api/reels/diag` and `/api/compare` return 404; `/api/ops/metrics` and `/api/admin/users` return 401; a cross-origin POST to `/api/auth/login` returns 403 `ORIGIN_DENIED`; no `Access-Control-Allow-Origin` for a foreign origin or for `http://localhost:5173`; the media bucket has no listing and its CORS allows only the app origin; the edge cache serves only anonymous responses (`s-maxage=30`, `Vary: Origin, Cookie`); `nosniff`, `X-Frame-Options: DENY`, COOP, Referrer-Policy and Permissions-Policy are sent.

## Lower priority

- **Account enumeration.** Registration answers 409 `EMAIL_TAKEN`. The password-reset request sends the email inside the request only when the account exists, so it takes longer for a real account.
- **Turnstile is skipped when `SX_TURNSTILE_SECRET` is empty** (`server/social/turnstile.py`). There is a boot warning and no boot check. On production both keys are set, and a reset request with no token returned 400 `BOT_CHECK_FAILED` (measured 2026-11-16).
- **Targeted lockout.** The `login-account` limit (10 tries in 15 minutes for one identifier) lets anyone lock a known account out of sign-in for that time.
- **`style-src 'unsafe-inline'`** in the CSP.
- **Compose images are not pinned:** `cloudflare/cloudflared:latest`, `caddy:2`, `postgres:16` (`compose.yaml`). The build bases in the `Dockerfile` are pinned by digest.
- **The public repository holds a personal email address** in `scripts/dev/experiment_fetch_city_photos.py`, and the docs describe the infrastructure in detail.

## Reviewed, no finding

- Sessions (40-byte token, SHA-256 at rest, HttpOnly, SameSite=Lax), CSRF bound to the session, origin validation, argon2id.
- The route table: every state-changing route has the CSRF dependency, except the ones meant to be anonymous (sign-in and sign-up, the Stripe webhook, view and event beacons, signed-out support).
- Ownership checks on jobs, staged uploads and published sources; conversation membership for messages; admin and moderator gating.
- Outbound requests go to fixed hosts only. ffmpeg and ffprobe run with argument lists, never through a shell.
- Avatars are re-encoded; uploads have an extension allowlist and size caps; custom fal arguments are limited to flat scalar values.
- The Stripe webhook checks the signature, the body size and a rate limit.
- The container runs as a non-root user, ports bind to loopback, `.env` is excluded from the image.
- Git history: the `.env` in the first commit held an empty `FAL_KEY`, so no secret was leaked.
- `npm audit --omit=dev`: 0 vulnerabilities. CI runs pip-audit, npm audit, gitleaks and a Trivy image scan.
- The SPA has no user data in `innerHTML` sinks; the wallet `postMessage` listener checks `event.origin`; profile links are http(s) only with `rel="noreferrer noopener"`.

## VPS and production checks

Measured on 2026-11-16 on the VPS (Debian 13, kernel 6.12.113) and from it.

### New findings

- **A second public tunnel serves the app (medium).** The container `echo-quicktunnel` (`cloudflared tunnel --url http://127.0.0.1:8000`, host network, not part of the compose project) has run since 2026-10-29. Its `trycloudflare.com` address answers with the full site and `/api/readyz`. It is a leftover from the 2026-10-29 latency profile (`docs/performance-latency-profile-2026-10-29.md`); nothing in the repo uses it. Requests through it reach the app port directly, past the Caddy proxy and any rule set on the `echomultiverse.com` zone. Measured: plain HTTP on that address answers 200 with no redirect, and the HTTPS response has no HSTS header. **Removed 2026-11-16** with `docker rm -f echo-quicktunnel`: the address now answers 530, the main site answers 200, and nothing listens on port 20241.
- **TLS 1.0 and 1.1 are accepted** on `echomultiverse.com` and `media.echomultiverse.com` (handshakes completed with `ECDHE-ECDSA-AES128-SHA` and `ECDHE-RSA-AES128-SHA`). TLS 1.2 and 1.3 work. Set Cloudflare SSL/TLS, Edge Certificates, Minimum TLS Version to 1.2.
- **A reboot is pending since 2026-11-15.** Kernel `6.12.117` is installed and `6.12.113` is running (uptime 18 days). `unattended-upgrades` does not reboot on its own. **Rebooted 2026-11-16 06:17 UTC:** the host runs `6.12.117`, no reboot is pending, all production and SIT containers came back healthy, and `/api/readyz` answered 200 about 45 seconds after the reboot command.
- **The CI deploy key has full control of the host.** The `echo-ci` key in `~debian/.ssh/authorized_keys` has no `command=` or `from=` restriction, and `debian` has passwordless sudo and is in the `docker` group. Anyone who gets the `VPS_SSH_KEY` Actions secret is root on production. CI sends the script on stdin (`bash -s -- $GITHUB_SHA < deploy/deploy.sh`, `.github/workflows/ci.yml:222`), so a plain forced command would break the deploy. Use a wrapper on the host as the forced command that accepts only a commit hash from `$SSH_ORIGINAL_COMMAND` and runs the checked-in `deploy/deploy.sh`, with `no-port-forwarding,no-agent-forwarding,no-pty`; or give CI its own user without sudo.
- **Backups are not encrypted before upload and have no retention rule in the script.** `deploy/backup.sh` streams a `pg_dump` and the avatars tarball to the private R2 bucket. The dump holds emails and password hashes. 16 daily folders exist (2026-11-01 to 2026-11-16) and none has been removed. Retention is the bucket's 30-day lifecycle rule (set 2026-11-07, recorded in `docs/to-beta.md`), so the first folder should go after 2026-12-01; the rule itself was not read in the dashboard. Seven `.env.bak-*` files with old secrets sit next to `.env` (mode 600).
- **Low:** `fail2ban` is not running, and the SSH log shows 2,761 failed attempts in 24 hours (password sign-in is off, so they cannot succeed); `X11Forwarding yes`; `SX_SUPPORT_EMAIL` is empty; `cloudflared`, `caddy` and `postgres` run from unpinned tags.

### Correct

- SSH: keys only (`passwordauthentication no`, `kbdinteractiveauthentication no`), `permitrootlogin no`, no key for root, two keys for `debian` (the operator's laptop and CI). Three accounts have a shell: `root`, `debian`, `echosit`; `echosit` has no sudo.
- Firewall: `ufw` active, default deny incoming, TCP 22 only. The app (8000), the proxy (8080) and the SIT ports listen on `127.0.0.1` only. Postgres is not published.
- Updates: `unattended-upgrades` is enabled; 0 security updates pending (8 others, Docker packages and tzdata).
- `.env`: mode 600, owner `debian`. `SX_ENV=production`, `SX_COOKIE_SECURE=1`, `SX_TRUST_PROXY_HEADERS=1`, `SX_DEV_ORIGINS=` (empty), `SX_PASSWORD_RESET_EXPOSE_TOKEN=0`, Stripe, credits and rewards off. `SX_SECURITY_SECRET`, `SX_MESSAGE_ENCRYPTION_KEY`, `SX_FAL_KEY_ENCRYPTION_KEY` and `POSTGRES_PASSWORD` are 64 characters each. Turnstile site key and secret are set. No duplicate keys.
- Containers: the app runs as user `app`, none is privileged, none adds capabilities. The Docker socket is `root:docker`, mode 660.
- Backups: cron runs `deploy/backup.sh` at 03:15 UTC. The last three runs ended with `backup: done`; the 2026-11-16 dump is 64.5 MB. The rclone config is mode 600.
- Database: PostgreSQL 16.15, one superuser role, schema `20261114_0025`.
- Signed out on production: a state-changing request returns 401 `AUTH_REQUIRED`; admin, moderation and ops routes return 401; an unknown job id returns 404.

### Signed-in flows on production

Measured on 2026-11-16 in a browser session of a normal account (`test22`, role `user`). Ids of another user's conversation, post and pack were read from the production database. Every write attempt was one that changes nothing if it is accepted (an unknown id or an empty body).

- **Cookies:** only `echo_csrf` is readable from JavaScript, so the session cookie is HttpOnly. `echo_csrf` is Secure, SameSite=Lax, path `/`, host-only, 30 days. Secure and SameSite on the session cookie cannot be read from a page; the VPS has `SX_COOKIE_SECURE=1`.
- **CSRF:** a write with no token and one with a wrong token return 403 `CSRF_FAILED`. With the real token the same request passes the check (404 `POST_NOT_FOUND` for an unknown id).
- **Staff routes as a normal user:** `/api/admin/users`, `/api/moderation/stats` and `/api/moderation/reports` return 403 `MODERATOR_REQUIRED`; `/api/ops/metrics` and `PUT /api/admin/users/{id}/role` return 403 `ADMIN_REQUIRED`.
- **Role fields cannot be set from the profile:** `PATCH /api/users/me` with `role`, `can_moderate` and `account_type` returned 200 and changed none of them.
- **Other users' data:** another user's conversation returns 404 `CONVERSATION_NOT_FOUND`; editing another user's post returns 403 `FORBIDDEN`; a deleted post's comments and a deleted pack return 404; another user's profile has no email field; unknown video and image job ids return 404.
- **Own Fal key:** `GET /api/account/fal-key` returns `configured` and a hint of 8 characters, not the key.
- **Caching:** the signed-in feed is `private, no-store` and `cf-cache-status: DYNAMIC`.
- **Not shown by these probes:** the owner check on `PATCH /api/packs/{id}` (the empty body was rejected with 422 before the handler ran), another user's live job (jobs are held in memory, so there was no id to use), and a cross-site request carrying the session cookie.

## Not checked

- A restore from a backup (the runbook is `docs/backup-restore-runbook.md`), and the R2 lifecycle rule on the backup bucket.
- Cloudflare dashboard settings (WAF, rate-limit rules) and the R2 bucket policy beyond listing.
- Load and coordinated abuse; the operator has a load baseline and will rerun it after the next deploy.
- Stripe flows (off on production).
