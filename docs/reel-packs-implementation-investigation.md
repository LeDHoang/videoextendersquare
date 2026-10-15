# Reel Packs — Implementation Investigation

Last updated: 2026-09-14 UTC (collection pipeline change: save-to-collection from 2D player and XR collect card, mixed-creator public-reel membership with per-viewer tombstones, publish 3–30 from PackPage and XR cards, curated-by display rule, draft-DM share guard; 11/11 pack pytest, 77/77 full `tests/` suite, 44 Node + 13 Vitest, vite build clean. Prior independent verification pass on macOS: alembic round trip, runtime probes, Meta WebXR documentation checks via `metavr` 1.3.2.2.2)

Status: **Implemented in the working tree; automated checks pass for the application surface. Physical Quest, accessibility, and sustained-performance release gates remain open.**

Related material:

- [Funding in Vietnam 2 source note](<File_000/Funding in vietnam 2/Funding in vietnam 2.md>)
- [Funding in Vietnam 2 broader VR Reels investigation](funding-in-vietnam-2-vr-reels-investigation.md)
- [VR playback investigation](vr-reels-playback-investigation.md)
- [Ordered project todo list](todolist.md)

## Executive finding

Reel Packs are worth implementing and are a better near-term product investment than a large generated World Shell. They turn already-published reels into finite, authored experiences without creating a second media format, a second social graph, or a second playback engine.

The implementation now treats a pack as a first-class live object:

- It has a stable ID, canonical `/packs/:packId` URL, creator, title, description, cover, tags, location, visibility, revision, saves, progress, and ordered members.
- It appears as a visibly distinct collection in Explore, tag and location discovery, creator profiles, saved content, sharing, and direct messages.
- It plays through the existing 2D and WebXR reel player in a finite Pack mode, while preserving the actions that belong to the current reel.
- Saving or sharing the Pack is separate from saving or sharing an individual reel.
- Shared and saved Packs remain live references to the creator's current published revision.
- Concurrent creator mutations use a revision claim so stale edits receive a conflict instead of silently replacing newer work.

This is the correct product shape for ECHO. It gives users a clear reason to curate, revisit, and send groups of reels, while preserving ordinary reel behavior and leaving room for richer immersive media later.

## Investigation scope

The review covered:

1. The complete `Funding in vietnam 2.md` note.
2. All seven bundled attachments:
   - `IMG_0948.jpeg`
   - `IMG_1528.heic`
   - `IMG_1712.jpeg`
   - `IMG_2289.png`
   - `IMG_3379.png`
   - `Image.png`
   - `New Note.png`
3. Existing ECHO discovery, profiles, saving, messaging, moderation, analytics, reel playback, image playback, and WebXR rendering.
4. The completed Reel Packs models, migration, API, React pages, embedded player state machine, and immersive controls.
5. Spotify playlist behavior as a product reference for stable collection identity, ordered membership, saving, sharing, resuming, and live updates.
6. Quest comfort, interaction, spatial-layout, accessibility, and WebXR release guidance available in the local project skills.

The linked Instagram posts in the source note were not independently authenticated. Their accompanying text was treated as the author's intended observation, not as verified evidence about an external product or technology.

Official Meta documentation verification was originally blocked because the `metavr` package available in the earlier Linux environment had no `linux-x64` binary. On 2026-09-14 the checks were re-run successfully on a macOS host with `metavr` 1.3.2.2.2 (`npx -y metavr docs search` and `npx -y metavr docs fetch`). The WebXR feature-detection guidance in `documentation/web/webxr-overview.md`, the hand-input behavior in `documentation/web/webxr-hands.md`, and the system-keyboard requirements in `documentation/web/webxr-keyboard.md` were confirmed to match the implementation. No claim in this document should therefore be interpreted as current Meta platform-policy or Store certification. Validate on physical target Quest devices before release.

## What the source material contributes

The source note is broad and mixes useful product ideas with concepts that should not be built. For Reel Packs, the valuable recurring pattern is not manipulation or endless engagement; it is authored sequencing: a creator selects a bounded set of moments, establishes an order, gives the set an identity, and lets another person experience it as one coherent object.

| Source | Relevant observation | Product consequence |
|---|---|---|
| `IMG_3379.png` — View-Master reels | A finite physical reel contains a deliberately ordered set of views and has a recognizable collection identity. | Strongest direct support for finite Reel Packs, explicit order, clear start, and clear ending. |
| `IMG_1528.heic` — curved projection room | One primary media surface can be strengthened by peripheral context without replacing the source. | Packs should use one authoritative reel at a time and stable supporting UI, not multiple competing autoplay surfaces. |
| `IMG_2289.png` — MTV Cribs/personal tours | Tours naturally consist of chapters or stops and work as episodes. | Property, hospitality, studio, venue, and creator-space Packs are strong early use cases. |
| `IMG_1712.jpeg` — place exploration | People want to enter recent experiences associated with a place. | Location-filtered Packs are useful in Explore now and can later become curated Earth destinations. |
| `IMG_0948.jpeg` — low-friction immersion | Ordinary media should be immediately viewable before asking for immersive commitment. | Every Pack remains fully functional in 2D and offers XR as an optional continuation. |
| `Image.png` — wearable/social hardware | Future viewers may not use two controllers or a large room. | Core Pack navigation must work seated, one-handed, with controllers or hands, and must retain a 2D fallback. |
| `New Note.png` — simulation/preparation | Structured sequences can be useful for rehearsal, learning, or guided experiences. | Educational or training Packs may be valid when explicit and consensual; covert conditioning is excluded. |

The note's suggestions involving stolen media, deceptive memories, coercive conditioning, casino-style attention capture, biometric resale, or undisclosed manipulation are not product opportunities. They remain explicit exclusions.

## Why Reel Packs rank second

Reel Packs have unusually favorable leverage:

- They reuse the existing post, creator, moderation, playback, comments, likes, follows, saving, and messaging systems.
- They create a new discovery and retention object without generating new media.
- Their finite ending is healthier and more distinctive than falling into an endless recommendation feed.
- They support both ordinary flat reels and immersive reels because the collection controls sequence, not rendering format.
- They are useful before World Shell exists and automatically become more valuable as richer reel formats are introduced.
- They create clear commercial formats: tours, event recaps, travel guides, restaurant trails, artist releases, lessons, and themed archives.

The main architectural prerequisite is a player that can render video, images, and static interface cards from shared state. That contract is now present in the Pack path. The larger persistent media-metadata contract for projection, stereo layout, rendition selection, captions, provenance, and comfort remains a separate prerequisite for future World Shell work.

## Spotify behavior comparison

Spotify is useful as a behavioral reference, not as a visual or branding template.

### Patterns adopted

- **Stable collection identity:** the Pack has its own object and URL rather than being encoded as temporary reel query parameters.
- **Ordered membership:** creator order is authoritative and playback is deterministic by default.
- **Collection-level actions:** opening, saving, sharing, and resuming a Pack do not imply the same action on every member.
- **Live references:** a saved or messaged Pack resolves its current accessible state instead of freezing a copied snapshot.
- **Distinct library and discovery representation:** a Pack is not disguised as one reel and never opens its cover reel by mistake.
- **Resume behavior:** progress is tied to a stable Pack-item ID and media position, so reordering does not redirect progress to the wrong reel.
- **Optimistic-concurrency revision:** creator changes use a revision comparable in purpose to a playlist snapshot identifier.

### Patterns intentionally not copied

- No default-public assumption: creators explicitly choose public or unlisted.
- No collaborative editing in V1.
- No shuffle-first behavior; authored order is the default contract.
- No automatic continuation into unrelated recommended reels after completion.
- No expiring access links or link-based permission bypass.
- No private/subscriber/paid Pack behavior until the permission model is designed and tested.
- No copied Spotify branding, terminology, or layout.

## Implemented product contract

### Authoring and publication

- Collections are personal draft packs. The pipeline is: see a reel → save it to a collection (general save and collection saves are separate actions) → the collection owner can publish the collection as a Reel Pack.
- Drafts allow 0–30 unique reels created through either the editor or the save-to-collection flow (`POST /api/packs/:id/items`, idempotent; `DELETE /api/packs/:id/items/:postId`).
- Publishing requires 3–30 currently available reels (testing cap: `PACK_MAX_ITEMS = 30`).
- A collection may mix reels from any creator: membership requires a currently published reel from an active owner that the collector can view (no block in either direction). Public reels only.
- Collection owners set title, description, up to five tags, optional city/country, cover reel, and exact member order in the 2D editor; PackPage exposes publish plus a visibility choice (public/unlisted) for drafts.
- Desktop drag-and-drop and explicit up/down buttons provide pointer, keyboard, and mobile-compatible reordering paths.
- The selected cover uses a poster when available. Image media may use its image URL. Video URLs are never incorrectly used as `<img>` sources.
- When no usable selected poster exists, the UI builds a static collage from up to four available member covers.
- Duplicate member reels, unpublished/deleted reels, and more than 30 members are rejected.
- Published edits preserve the Pack ID and canonical URL.
- Edit, publish, unpublish, delete, and item add/remove operations use revision claims; a stale request returns `409 PACK_REVISION_CONFLICT` and its transaction is rolled back.

### Removed or moderated members

Pack item IDs and positions remain structurally stable when a post reference becomes unavailable. The API returns an unavailable item without post details, and playback renders a static unavailable card and skips it during next/previous navigation.

Availability is per viewer: a member reel whose creator blocks the viewer (or is blocked by them) renders as a tombstone with no post payload for that viewer, while other viewers still see it. Blocking between the viewer and the pack curator hides the whole pack as before.

A published public Pack with fewer than three playable items is:

- marked `needs_repair` for its creator;
- removed from public discovery;
- still accessible by direct URL to an authorized viewer while at least one item remains playable.

When no playable item remains, the Pack resolves as unavailable to non-owners. This prevents protected post data from leaking through a collection.

### Discovery

The main Explore page supports `ALL`, `REELS`, and `PACKS`:

- `REELS` preserves the existing reel gallery.
- `ALL` shows a labeled Reel Packs section and the normal reel results.
- `PACKS` shows a Pack-only grid with 24-item pagination and Load More behavior.

Pack discovery searches title, description, creator username/display name, tags, and location. Tag and location routes also show matching Pack sections. Location matching accepts both the canonical city/country key form such as `hanoi--vietnam` and a normalized search form such as `hanoi-vietnam`.

Public profiles have a `PACKS` tab. The current user's Saved tab separates `REELS` and `PACKS`. Owners retain access to their drafts in their own Pack view; other viewers see only eligible published Packs.

### Collection tile

`PackTile` is deliberately separate from the ordinary reel tile. It provides:

- a static cover or fallback collage;
- a stacked-card glyph and persistent `REEL PACK` label;
- title, curated-by creator, reel count, optional location, and repair state;
- independent Save Pack and Share controls;
- an accessible collection label;
- keyboard activation that opens the Pack only when the tile itself is activated, without allowing nested save/share controls to bubble into an unintended open.

The tile records a `pack_impression` only after it becomes substantially visible where `IntersectionObserver` is available.

### Detail and playback

The canonical route is `/packs/:packId`. It presents metadata, curator, count, visibility, revision, location, tags, save/share/report or owner controls (draft owners additionally get publish plus a visibility choice), resume state, and the complete ordered member list.

Curator attribution is collection-level only: PackTile, the PackPage hero, XR queue/intro cards, and message cards read `CURATED BY @x`; reel-level surfaces (track rows, playback meta) keep the individual reel's creator.

The player uses one Pack state machine:

```text
intro -> playing -> complete
```

Pack playback:

- starts or resumes from a stable Pack-item ID;
- restores media position for the active item;
- supports previous, next, and direct queue selection;
- skips unavailable items;
- auto-advances only inside the authored Pack;
- ends on a Pack completion card;
- offers Replay Pack, Return to Pack, and Explore Packs;
- never falls through into the endless recommendation feed;
- disables feed-only pagination and negative-feedback controls while in Pack mode.

The active reel keeps its applicable reel actions: like, comments, Save Reel, Share Reel, follow/profile, report, play/pause, seek, mute, and projection/immersive controls. Pack Save and Pack Share are separate controls and do not alter reel state.

### Saving

- Pack saves use a unique user/Pack relationship.
- Save and unsave are idempotent and keep the denormalized save count non-negative.
- Saving a Pack does not save its members.
- Saving a member reel does not save its Pack.
- A directly accessed unlisted Pack can be saved.
- Saved results re-check current permission and availability, so inaccessible Packs disappear without explaining whether deletion, moderation, blocking, or visibility caused it.
- If access returns later, the existing save relationship becomes visible again.

### Sharing and messaging

The share contract is generalized to `{ kind: "reel" | "pack", id, title? }` while the old reel endpoint remains as a compatibility wrapper.

Accessible Packs support:

- canonical URL retrieval;
- native OS share where available;
- clipboard fallback;
- QR generation/download;
- in-app sending to 1–10 recipients;
- an optional note.

Message idempotency derives a recipient-specific UUID from batch ID, content kind, target ID, and recipient. This prevents a Pack and reel—or two different targets—from being incorrectly deduplicated. The share dialog rotates its batch ID after a fully successful send, while retaining it for failed-recipient retry safety.

Messages render a distinct Pack attachment with a cover/collage, `REEL PACK` label, title, creator, reel count, optional note, and `OPEN PACK` action. Conversation previews say that a Reel Pack was shared. Opening a Pack attachment records `pack_message_open`. Deleted, unpublished, moderated, blocked, or otherwise inaccessible Packs render a generic tombstone and do not reveal the reason.

## Persistence and API implementation

Migration `20260913_0009` adds:

- `reel_packs`
- `reel_pack_items`
- `reel_pack_tags`
- `reel_pack_saves`
- `reel_pack_progress`
- nullable `pack_id` on `direct_messages`
- nullable `pack_id` on `engagement_events`

Migration `20260913_0010` adds collection engagement counters and de-duplicated viewing:

- `like_count`, `view_count` on `reel_packs`
- `reel_pack_likes` (unique user/Pack)
- `reel_pack_views` (per-viewer rolling window)

Collections expose read-only likes/views/comment counters. Likes are per-viewer
and idempotent. A view is any `pack_start` and counts both authenticated and
anonymous viewers, de-duplicated per viewer in a rolling 10-minute window. The
comment count aggregates live comments across the member reels the viewer can
see; there is no Pack-level comment thread.

Collections also open straight into playback: there is no start/intro gate. A
finished Pack replays from the top, a half-watched Pack resumes, and a new Pack
starts at the requested member. `START PACK`/`RESUME` buttons are gone from the
Pack page; the hero cover itself plays, and Explore collection tiles navigate
directly to the player.

Important constraints include unique Pack/post membership, unique Pack/position, one save per user/Pack, one progress row per user/Pack, non-negative positions and progress, and a message check preventing simultaneous reel and Pack attachments.

Implemented HTTP endpoints:

| Endpoint | Behavior |
|---|---|
| `GET /api/packs` | Public discovery with search, tag, location, owner, offset, and limit. |
| `POST /api/packs` | Create a draft. |
| `GET /api/packs/:id` | Resolve an authorized live Pack detail. |
| `PATCH /api/packs/:id` | Update metadata and/or complete ordered member list with expected revision. |
| `POST /api/packs/:id/items` | Append one public reel to the collection (save-to-collection flow); idempotent, optional expected revision. |
| `DELETE /api/packs/:id/items/:postId` | Remove one member reel from the collection. |
| `DELETE /api/packs/:id` | Soft-delete with expected revision. |
| `POST /api/packs/:id/publish` | Publish a valid 3–30 item Pack with expected revision. |
| `POST /api/packs/:id/unpublish` | Return a Pack to draft with expected revision. |
| `PUT /api/packs/:id/save` | Idempotently save a Pack. |
| `DELETE /api/packs/:id/save` | Idempotently unsave a Pack. |
| `PUT /api/packs/:id/like` | Idempotently like a Pack; returns `likes`/`liked_by_me`. |
| `DELETE /api/packs/:id/like` | Idempotently unlike a Pack. |
| `POST /api/events` (`pack_start`) | Records a de-duplicated collection view for auth and anonymous viewers. |
| `PUT /api/packs/:id/progress` | Persist stable item ID, position, and phase. |
| `GET /api/packs/:id/share` | Return canonical sharing metadata. |
| `GET /api/users/:username/packs` | Public creator Packs, plus owner drafts for the owner. |
| `GET /api/users/me/packs` | Current user's Pack library. |
| `GET /api/users/me/saved-packs` | Authorized live saved Pack references. |
| `GET /api/reels/player-inline?pack_id=...` | Finite Pack payload using the existing player wire shape. |
| `POST /api/messages/share-content` | Send a reel or Pack to up to ten recipients. |

The finite player response contains Pack metadata/revision, exact ordered items, stable Pack-item IDs, resume state, `has_more: false`, no recommendation cursor, and an independent immersive feature flag.

## Shared 2D and immersive architecture

The Pack does not have separate content logic for 2D and WebXR. `reels_pack_state.js` owns source mode, phase, item index, availability skipping, completion, and progress payload construction. The existing player owns reel interactions and media lifecycle. The WebXR renderer consumes callbacks and visual sources instead of owning a second Pack queue.

The visual source contract covers:

- `video`: the active HTML video and playback adapter;
- `image`: an image source using existing dwell/advance policy;
- `static-card`: intro, completion, loading, queue, and unavailable states.

When an image begins loading, the previous reel texture is cleared immediately so XR never displays stale content while the next source is pending.

### 2D behavior

- Pack detail and authoring are native React routes.
- Playback reuses the embedded reel player.
- Intro, queue, unavailable, and completion states have explicit controls.
- Entering or leaving immersive mode preserves the Pack phase, item, current media time, play/pause state, and mute state.
- Unsupported XR or failed initialization leaves the user in functional 2D playback.

### WebXR behavior

- Pack routes are accepted by the existing immersive player.
- The renderer handles video, image, and static-card textures.
- Feed/Earth switching is replaced by a Pack position/queue control in Pack mode.
- The central queue shows Pack identity, current position, ordered members, Save Pack, and Share Pack.
- A COLLECT dock control (feed mode) opens the SAVE TO card: just-save, add to any of the owner's draft collections, or create a new collection without leaving XR.
- Draft collections expose a PUBLISH COLLECTION action on the intro and completion cards when the viewer is the owner and at least three items are available.
- Reel actions and Pack actions use distinct callbacks.
- Intro and completion cards remain stable in the central viewing zone rather than following every head movement.
- Controllers and hands use the existing ray interaction system with visible hover/press state.
- Core playback is usable with one hand and from a seated position by design; physical validation is still required.
- DOM-only actions safely exit XR, persist progress, and open the requested 2D interface.

The code does not introduce forced camera movement, automatic continuation, or additional autoplaying video surfaces.

## Permissions, privacy, and safety

The server re-checks access when a Pack is listed, opened, saved, played, shared, rendered in a message, or attributed in analytics. Important properties:

- Blocking is enforced between viewer and Pack creator, and per member reel between the viewer and that reel's creator (viewer-specific tombstones).
- Draft and unlisted visibility is not leaked through public discovery.
- Message attachments resolve live permissions each time they are serialized.
- Unavailable responses are generic and do not reveal moderation, deletion, block, or visibility details.
- Member reels may come from any creator but must be published, owned by an active account, and visible to the collector at authoring time.
- Unavailable member rows contain no protected post payload.
- Pack-level reports cover abusive metadata or curation; reel reports remain independent.
- Soft deletion keeps historical message structure while making the target unavailable.
- Analytics preserve individual reel attribution with `source=pack` and `pack_id`.

## Feature flags and rollout

Three independent default-on runtime flags are exposed through `/api/config`:

- `SX_REEL_PACK_CREATION_ENABLED`
- `SX_REEL_PACK_DISCOVERY_ENABLED`
- `SX_REEL_PACK_IMMERSIVE_ENABLED`

They allow staged rollout:

1. Enable creation for internal creators.
2. Enable public discovery after moderation and browser checks.
3. Enable Pack XR only after supported-host documentation verification and physical-device validation.

Disabling discovery does not invalidate a permitted direct link. Disabling immersive playback preserves the complete 2D experience.

## Known technical risks

### Physical-device performance

Desktop tests cannot certify Quest frame pacing, decoder behavior, texture upload cost, thermal stability, hand-tracking precision, or text readability. The existing project playback investigation already identifies high-resolution video texture upload as a risk. Pack mode adds static-card and queue rendering but intentionally does not add another video decoder.

### Discovery scalability

`GET /api/packs` currently loads eligible rows and applies rich text/tag/location matching in application code before slicing the requested page. This is correct for the current project scale and testable across SQLite, but should move to indexed database search or a search service before the Pack catalog becomes large.

### Cover lifecycle

Poster generation remains upstream of Pack creation. Video-only Packs without posters correctly avoid using MP4 URLs as images and fall back to available cover art/placeholders, but production quality depends on reliable poster extraction.

### External platform verification

The implementation uses the project's existing custom WebXR renderer rather than introducing an unverified Meta-specific SDK dependency. Current Meta WebXR documentation was verified on a supported macOS `metavr` host on 2026-09-14: the VR-button gating matches the runtime-feature-detection guidance in `webxr-overview.md`, hand input matches `webxr-hands.md`, and DOM-overlay/system-keyboard usage matches `webxr-keyboard.md`. Meta Horizon Store policy and Quest Browser version-matrix behavior remain unverified.

### Accessibility verification

The structure provides labels, non-color Pack identification, keyboard move controls, large immersive targets, and one-handed paths. These still require screen-reader, keyboard-only, grayscale, seated, controller, and hand-tracking validation on representative devices.

## Automated verification status

Completed on 2026-09-14 (independent verification pass on macOS):

- `tests/test_reel_packs.py`: 9 passed.
- Full `tests/` suite including `tests/test_cloud_routes.py`: 75 passed. The earlier exclusion no longer applies: `sse-starlette>=2.0` is declared in `requirements.txt` and installed in the project `.venv`, so `tests/test_cloud_routes.py` collects and passes (7 tests).
- Node/Vitest web suite: 40 Node tests and 13 Vitest tests passed (includes 7 pack visual/form regression tests and 7 pack-state tests).
- `npm run build`: production Vite build passed.
- `node --check ui/assets/webxr_vr.js` and `ui/assets/reels_pack_state.js`: passed.
- Python `ast.parse` on `packs.py` / `reels.py` / `messages.py`: passed.
- Alembic temporary SQLite round trip through revision `20260913_0009`: upgrade, downgrade to base, and upgrade to head re-verified on macOS.
- Independent runtime probes on an isolated SQLite database re-confirmed: repair-hiding below the publish threshold, non-owner 404 versus owner 200 at zero playable items, unpublish/republish save and message-tombstone transitions, blocking enforcement, anonymous `pack_impression` acceptance, stable resume `start_index`, and the DB-fallback player payload.

Updated verification after the collection pipeline change (2026-09-14):

- `tests/test_reel_packs.py`: 11 passed, including new coverage for mixed-creator membership, collection item add/remove (idempotent duplicate, stale revision 409, cover clearing), publish at three, per-viewer blocked-member tombstones in detail and player payloads, and the draft pack guard on the generic DM endpoint.
- Full `tests/` suite: 77 passed.
- Node/Vitest web suite: 44 Node tests (includes new collection-pipeline regression tests) and 13 Vitest tests passed.
- `npm run build`, `node --check` on `webxr_vr.js`/`reels_pack_state.js`, inline reels.html script syntax checks, and Python `ast.parse`: passed.

The unscoped repository-root `pytest` command is not a valid project signal because it also collects the nested ComfyUI test tree and unrelated root experiments. It failed during collection on missing external fixtures/modules and allowed the nested `ComfyUI/server.py` module to shadow the ECHO `server` package. The intended `tests/` suite was run separately.

## Acceptance status

| Requirement | Status |
|---|---|
| Creator can save reels to a 0–30 item collection and publish at 3–30 | Implemented and tested |
| Mixed-creator membership (any creator's public reels, block-aware) | Implemented and tested |
| Save to collection from 2D player and XR collect card | Implemented; physical-device QA pending |
| Publish from the collection page and XR intro/complete cards | Implemented; browser QA pending |
| Ownership, duplicate, status, order, and cover validation | Implemented and tested |
| Stable URL and live-reference edits | Implemented |
| Atomic revision conflicts | Implemented and stale conflict tested |
| Public/unlisted visibility and repair hiding | Implemented and tested |
| Explore `ALL / REELS / PACKS` with Pack pagination | Implemented; browser QA pending |
| Tag, location, creator, and saved Pack discovery | Implemented; API filters tested |
| Distinct accessible Pack tile | Implemented; manual screen-reader/grayscale QA pending |
| 2D start/resume/queue/previous/next/completion | Implemented; state-machine tests pass |
| Completion never enters endless feed | Implemented and tested |
| Reel actions remain available and separate from Pack actions | Implemented; manual end-to-end QA pending |
| Save Pack independent from Save Reel | Implemented and tested |
| Canonical/native/copy/QR/in-app sharing | Implemented; manual browser/native-share QA pending |
| Distinct live Pack message attachment and tombstone | Implemented and tested |
| Video, image, unavailable, intro, queue, and completion in XR | Implemented; renderer tests pass |
| 2D to XR to 2D state preservation | Implemented; physical-device QA pending |
| Controller, hand, seated, one-handed behavior | Designed and implemented; physical-device QA pending |
| Lowest-supported-headset frame/thermal budget | Not yet certified |
| Current Meta WebXR documentation verification | Verified on a supported macOS `metavr` host 2026-09-14 (WebXR overview, hands, system keyboard); Store policy and Browser version matrix still unverified |

## Remaining release gates

1. Record the exact Meta documentation URLs (WebXR overview, hands, system keyboard) and the Quest Browser version matrix used in the 2026-09-14 macOS verification, and run the outstanding Quest Browser, accessibility, and Store policy searches.
2. Test create, edit, publish, unpublish, stale conflict, and delete flows in two concurrent browser sessions.
3. Test Explore, tag, location, profile, saved library, links, browser back/forward, native share, clipboard, QR, and 10-recipient messaging in supported browsers.
4. Test screen-reader labels, keyboard-only authoring, focus order, grayscale distinction, reduced motion, captions where present, and responsive mobile layout.
5. Run the complete Pack matrix on the lowest-powered supported Quest: video, image, unavailable item, intro, queue, completion, controller, hand, one-handed, seated, tracking interruption, XR exit/re-entry, and network interruption.
6. Record frame rate, CPU/GPU frame time, draw calls, texture memory, thermal state, long-session memory, and decoder behavior. Do not enable immersive Pack rollout if it exceeds the existing certified playback budget.
7. Keep the full `tests/` suite (75 passed including `tests/test_cloud_routes.py`) green in CI; `sse-starlette>=2.0` is already declared in `requirements.txt`, so any collecting environment only needs those requirements installed.
8. Stage rollout independently: creation first, discovery second, immersive last.

## Final recommendation

Keep Reel Packs. The implementation fits the current product, behaves distinctly from a reel, preserves familiar reel interactions, and works through the same finite state in 2D and immersive modes. It is a practical bridge between today's social feed and future spatial experiences.

Do not make public claims of Quest certification yet. The remaining work is release validation—especially physical-device comfort, accessibility, performance, and supported-host Meta documentation verification—not a redesign of the Pack model.
