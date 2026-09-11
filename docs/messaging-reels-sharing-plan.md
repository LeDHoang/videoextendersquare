# Reels Sharing and Direct Messaging

Last updated: 2026-09-11

## Product decisions

- One-to-one conversations only.
- Message bodies are encrypted at rest with AES-GCM. This is not end-to-end encryption.
- Text, curated emotes, Tenor GIFs, and published reel attachments are supported.
- Users followed by the recipient enter the inbox; other users create one-message requests.
- Realtime delivery uses authenticated SSE plus REST mutations.
- Reel sharing supports native share, copied canonical links, local QR codes, and up to ten in-app recipients.
- Notifications are in-app only. Sound is opt-in.
- The compact chat dock is hidden during fullscreen and WebXR sessions and restores its prior state afterward.

## Architecture

- FastAPI owns authentication, conversation policy, encryption, Tenor access, durable message events, and moderation evidence.
- SQLAlchemy/Alembic stores conversations, members, encrypted messages, and a recipient-scoped event outbox.
- React uses a single messaging provider for the full messages page, compact dock, unread badges, drafts, and share dialog.
- Canonical reel links use `/reels?post=<post-id>`; the existing `play=<media-path>` form remains compatible.

## API contract

- `GET /api/messages/capabilities`
- `GET /api/messages/bootstrap?box=inbox|requests`
- `GET /api/messages/conversations/{id}/messages`
- `POST /api/messages/direct`
- `POST /api/messages/conversations/{id}/messages`
- `POST /api/messages/conversations/{id}/accept`
- `POST /api/messages/conversations/{id}/decline`
- `POST /api/messages/conversations/{id}/read`
- `DELETE /api/messages/{message-id}`
- `GET /api/messages/events?after=<event-id>`
- `GET /api/messages/gifs/search?q=<query>`
- `POST /api/messages/share-reel`
- `GET /api/posts/{post-id}/share`
- `POST /api/reports` with `target_type=message`

## Security and safety

- Encrypt all user-authored message payload fields; routing metadata and reel IDs remain queryable.
- Require CSRF protection for every mutation and apply per-user send, conversation, share, GIF, and report limits.
- Reject self-messaging, inactive/demo accounts, blocked relationships, arbitrary GIF hosts, and unavailable reels.
- Preserve encrypted report evidence if a reported message is subsequently deleted.
- Use idempotent client IDs for retries and per-recipient batch-share delivery.

## Acceptance criteria

- Two authenticated browser sessions exchange all four message kinds live without duplicate sends.
- Unknown senders appear under Requests and cannot send a second message before acceptance.
- Unread counts and read receipts survive refreshes.
- Link and QR sharing open the exact public reel while logged out.
- Sharing to ten recipients creates ten independent direct deliveries with per-recipient results.
- Blocking, deletion, missing reels, Tenor failure, SSE reconnects, and encryption failures degrade safely.
- The full page and compact dock are keyboard accessible and responsive.
- Quest Browser receives a physical-device pass before this feature is marked release-ready.

## Exclusions

- Group conversations, arbitrary file attachments, voice messages, message editing, typing indicators, presence, browser push, and immersive 3D chat.
