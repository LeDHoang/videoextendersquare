# To-do List

Last verified: 2026-09-11 against `bdfda1e` — deep functional pass: 18/18 backend flow checks + 8/8 round-2 checks + SSE probe + logged-out `?post=` deep link all green (plus repo suites: 4/4 pytest, 2/2 vitest, `vite build` clean).

## Done

- [x] Fix upload avatar (root cause: Vite dev proxy forwarded `/api` + `/media` but not `/avatars`, so uploads succeeded while avatar images 404'd on :5173; fixed by adding `'/avatars': 'http://localhost:8000'` to `web/vite.config.js`.)
- [x] Encrypted direct messaging — requests (pending/active), text/emote/GIF/reel kinds, idempotent sends via `(sender, client_id)`, read receipts, deletion, blocking, durable SSE events (`server/routers/messages.py`, `server/social/message_crypto.py` AES-GCM, migration `20260911_0003`). Note: app-level encryption with a server-held key, **not** true end-to-end (the UI discloses this).
- [x] Reel sharing — canonical links (`GET /api/posts/:id/share`), clipboard + native share, QR PNG download (`qrcode`), multi-recipient (≤10) idempotent delivery, entry points on Reels page, Explore tiles, profile, and player (`ReelShareDialog.jsx`).
- [x] Messages UI — responsive page (`/messages`), compact dock, unread badges, profile entry point (`MessagingContext.jsx`, `MessagingPanel.jsx`, `MessageDock.jsx`, `MessagesPage.jsx`).

## Still open

- [ ] Manual two-browser + Quest validation (see `docs/to-beta.md` checklist; milestone 8 in `docs/messaging-reels-sharing-progress.md`).
- [ ] Review the Explore page reels loading priority.
- [ ] Review VR immersive-mode reel playback and loading.
- [ ] Reduce and spread out controls on the player action rail.

## Known gaps found during verification (not yet fixed)

- `ReelShareDialog.jsx`: `client_id` batch key is generated once per `postId` and never rotated — a second distinct share of the same reel may dedupe as a duplicate.
- `MessagingContext.jsx:248-256`: send-reconcile builds `reconciled` but discards it (possible duplicate bubbles on key migration); optimistic GIF sends render empty until server echo.
- `Sidebar.jsx:16`: `/messages` nav item reuses the explore icon (should be a message icon).
- Report on an already-deleted message returns 404 `REPORT_TARGET_NOT_FOUND` (evidence path only verified for live messages).

## Deep-test notes (all passing, for the record)

- Request lifecycle: stranger DM → `pending`, second send → 409 `REQUEST_PENDING`, accept → `active`; decline → further sends rejected.
- Followed recipient gets an `active` conversation immediately; block (`PUT /api/users/:u/block`) → sends fail with `MESSAGING_BLOCKED`.
- Idempotency: duplicate `client_id` returns `duplicate: true` with no extra row, for both DMs and `share-reel` batches.
- History pagination via `next_before` cursor; `mark read` reduces unread counts; sender delete tombstones for receiver, non-sender delete → 403/404.
- GIF: direct send of allowlisted-host URL works without a Tenor key; off-host URL → 422; `/gifs/search` without key → 503 `GIF_SEARCH_UNAVAILABLE`.
- SSE `/api/messages/events` streams queued `message.created` events with cursor ids (`id:`/`event:`/`data:` frames).
- Logged-out `GET /api/reels?post=<id>` returns exactly the one reel (200, `count: 1`); unknown id → 404 `POST_NOT_FOUND`. (Earlier concern about `ReelsPage` deep-link index was benign — the backend pre-filters to the single post, so index 0 is correct.)
- Client-id format enforced: `^[A-Za-z0-9._:-]{8,64}$`, else 422 `INVALID_CLIENT_ID`.
