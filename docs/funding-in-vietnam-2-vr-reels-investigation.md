# Funding in Vietnam 2 — VR Reels Product Investigation

Last updated: 2026-09-13 UTC

Status: **Review complete; implementation not started**

Source:

- [Funding in vietnam 2](<File_000/Funding in vietnam 2/Funding in vietnam 2.md>)
- All seven local files in [Attachments](<File_000/Funding in vietnam 2/Attachments/>)

Related records:

- [VR playback investigation](vr-reels-playback-investigation.md)
- [Earth mode plan](immersive-reels-earth-plan.md)
- [Recommendation-system plan](x-recommendation-system-plan.md)
- [Beta checklist](to-beta.md)
- [Ordered action list](todolist.md)

## Executive conclusion

The note contains several ideas worth pursuing, but they belong under one
focused product thesis:

> **ECHO should turn ordinary short-form media into progressively spatial
> experiences. Every reel should work immediately in a normal player, with an
> optional `ENTER WORLD` mode for immersive presentation.**

The strongest new feature is an AI-generated **World Shell**. The creator's
original reel stays unchanged on a central screen while a static or subtly
depth-layered generated environment surrounds it. The shell is created during
upload, clearly labeled as synthetic, and never required to watch the reel.

The strongest low-risk product-format idea is **Reel Packs**: finite, ordered,
shareable collections inspired by the View-Master attachment. Packs provide
authorship, a natural stopping point, and a useful structure for travel,
property, music, sports, history, and personal collections.

Before either is implemented, ECHO should finish its existing playback,
comfort, security, ownership, recommendation-concurrency, privacy, and physical
Quest validation work.

## Scope and verification

This investigation covered:

1. The complete 701-line source note.
2. Every bundled attachment.
3. The current React application, embedded Reels player, custom WebXR renderer,
   upload and processing pipelines, stereo spatialization, Earth mode,
   recommendations, social features, messaging, credits, and beta documents.
4. The local Quest comfort, interaction, spatial-layout, and accessibility
   guidance.

The linked Instagram posts were not independently authenticated and inspected.
Their accompanying text was treated as the author's intended observation, not
as verified evidence about the linked technology.

Required Meta documentation searches were attempted on 2026-09-13 for Quest
Browser immersive-video performance, spatial anchoring, and immersive
accessibility. Meta's `metavr` package reported that it has no `linux-x64`
binary. This document therefore makes no claim of current Meta API or Horizon
Store-policy compliance. A supported-host documentation check and physical
device pass remain release gates.

## Current project baseline

ECHO already implements much of the useful foundation suggested by the note.

| Area | Current implementation | Consequence |
|---|---|---|
| Processing | Square image/video outpainting, upscaling, HEVC masters, and browser proxies | Reuse the pipeline for World Shell assets. |
| Immersive player | Flat, square-curve, dome, starfield, ambilight, 6DOF placement, and spatial controls | Improve stability and comfort before adding scene complexity. |
| Stereo | Local monocular-video-to-SBS conversion | Continue, but identify format through metadata instead of names. |
| Social | Profiles, follows, likes, saves, comments, reports, blocks, and sharing | Reel Packs can build on existing identities and permissions. |
| Messaging | Direct messages, reel attachments, QR links, and share requests | Later watch parties can start from existing invitation flows. |
| Recommendations | Personalized cursor pagination and explicit negative feedback | Improve correctness and user control; do not build a second ranking stack. |
| Earth | City heat zones, hover previews, and recent place feeds | Extend as a social place browser, not a Google Earth replacement. |
| Economy | Credits, quotes, billing, BYOK, and qualified-view rewards | Optional spatial processing can use the existing model if it remains transparent. |
| Preview | Desktop immersive preview | Useful for iteration, but not a substitute for headset validation. |

Important implementation anchors:

- `README.md:39`: existing WebXR and media-processing features.
- `pipeline/spatial_worker.py:1`: local video-to-SBS implementation.
- `ui/assets/reels.html:2589`: comments.
- `ui/assets/reels.html:3000`: engagement actions.
- `docs/immersive-reels-earth-plan.md:53`: Earth mode.
- `docs/x-recommendation-system-plan.md:91`: recommendation architecture.
- `docs/outpainting-credits-progress.md:12`: credits and billing.

## Attachment review

### IMG_0948.jpeg — phone held over the eyes

The useful insight is low-friction immersion from ordinary media. ECHO should
retain immediate phone/desktop playback, one-action VR entry, and desktop
creator preview. Holding a phone against the face is not a target experience:
it has poor ergonomics, no robust spatial input, and no meaningful comfort
controls.

### IMG_1528.heic — curved projection room

The wraparound room shows that peripheral context can create presence without a
complete interactive reconstruction. It supports a central high-quality reel
surrounded by lower-detail imagery. Curvature, viewpoint, stable horizon, and
perspective are more important than merely maximizing pixel count. This is
strong visual support for a World Shell, but not a reason to enter the physical
projection business.

### Image.png — fashionable glasses

The image highlights wearability and social acceptance. ECHO should remain
hardware-independent, preserve a useful 2D/windowed presentation, and avoid
assuming two tracked controllers will always exist. Building custom glasses
would add optics, manufacturing, support, and distribution before the software
experience has proven demand.

### IMG_1712.jpeg — demand for Google Earth VR

The attachment supports place-based immersive exploration. ECHO's advantage is
not geographic completeness; it is letting someone enter recent experiences
created by people in a place. Existing city-level aggregation is the right
privacy boundary. Selecting a city should lead to recent reels and curated
packs, not a general-purpose mapping product.

### New Note.png — simulation as preparation

The benign version of this idea could support sports visualization,
public-speaking rehearsal, education, or explicit workplace training. It does
not justify covert conditioning, military simulation, weapons training, or
behavioral manipulation inside the social feed.

### IMG_2289.png — MTV Cribs and personal tours

Property, hospitality, studio, venue, vehicle, and creator lifestyle tours are
excellent early commercial formats. They are naturally spatial, can use slow
stable camera motion, and can be produced with the rights holder's permission.
Truthful representation and sponsored-content labeling are required.

### IMG_3379.png — View-Master reels

This is the strongest product-format reference. A digital Reel Pack could hold
five to twelve ordered moments with a cover, creator, theme or location, resume
position, and explicit ending. Packs could be shared through existing links and
messages or opened from Earth mode. The finite structure also avoids copying an
endless-scroll product without differentiation.

## Idea assessment

| Idea from the note | Decision | Reason |
|---|---|---|
| Expand a normal video into a larger AI environment | **Build** | Best fit with ECHO's pipeline and strongest differentiation. |
| Generate full moving 360 video for every reel | **Defer** | Temporal consistency, cost, latency, and invented geometry are not MVP-ready. |
| Generate one panorama from a keyframe | **Build first** | Delivers much of the effect with bounded processing and playback cost. |
| Flat, curved, and dome screens | **Continue** | Already implemented; comfort and device validation are the remaining work. |
| Convert normal video to stereo | **Continue carefully** | Already implemented; excessive disparity and wrong format detection can cause discomfort. |
| Automatically detect projection format | **Suggestion only** | Explicit creator/import metadata should be authoritative. |
| View-Master-style Reel Packs | **Build** | Strong identity, low technical risk, finite sessions, and broad reuse. |
| Earth heatmap/place drop-in | **Continue** | Already aligned with the note; connect it to packs and creators. |
| Travel and restaurant experiences | **Pilot** | Strong Earth synergy and achievable creator capture. |
| Property and luxury tours | **Pilot first** | Clear commercial value, stable content, and controllable rights. |
| Music videos and concerts | **Pilot with partners** | High impact, but music, venue, performance, and likeness rights matter. |
| Sports highlights | **Later** | Fast motion, rights, capture access, and comfort make it harder. |
| Historical reconstruction | **Later, labeled** | Useful only when sources and generated reconstruction are distinguishable. |
| Spatial memories | **Private research** | Requires consent, provenance, deletion, and emotional-safety controls. |
| 2.5D spatial photos | **Later prototype** | Lower cost than full volumetric video and suitable for existing image reels. |
| Time-synchronized comments | **Keep and refine** | Already built; needs moderation and bounded XR update cost. |
| Party viewing | **Later** | Existing messaging provides a foundation for lightweight synchronization. |
| Voice navigation | **Later and optional** | Useful for search, pause, recenter, and mode selection, with visible listening state. |
| Voice-generated live worlds | **Research** | Too expensive, slow, unpredictable, and difficult to moderate today. |
| Multiple autoplaying screens | **Avoid** | Adds decoder contention, visual clutter, and cognitive load. |
| Gaussian splats/4D reconstruction | **Research** | Promising but expensive in capture, storage, and standalone rendering. |
| Projection rooms/Sphere-like venues | **Out of scope** | Consider only as a later demonstration or partnership. |
| Custom View-Master or glasses hardware | **Do not pursue now** | Manufacturing would distract from software validation. |
| Open model framework | **Internal only initially** | Arbitrary models complicate security, billing, reliability, and provenance. |
| Credits for generation | **Continue** | Already present; pricing and rewards must remain transparent. |
| Creator payment based only on views | **Defer** | Requires stronger fraud detection and qualified-engagement measurement. |
| Bitcoin or universal currency | **Reject/defer** | Adds compliance and complexity without improving the core experience. |
| Eye/gaze tracking for advertising or data resale | **Reject** | Disproportionate privacy and trust harm. |
| Casino-style retention and attention shortening | **Reject** | Harmful and incompatible with a sustainable immersive product. |
| Stolen media, music, or IP | **Reject** | Copyright, platform, and creator-trust risk. |
| Fake memories or fake eyewitness media | **Reject** | High misinformation and psychological-harm risk. |
| Military, weapon, drone, or child-soldier conditioning | **Reject** | Outside the legitimate product scope and ethically unacceptable. |
| Bots presented as humans | **Reject** | Automated actors must always be identifiable. |

## Recommended core experience

ECHO should support a capability ladder:

1. **Original:** immediate flat playback.
2. **Framed:** flat, curved, or dome-screen presentation.
3. **Spatial:** conservative mono-to-stereo conversion where suitable.
4. **World Shell:** original media plus generated peripheral environment.
5. **Native immersive:** correctly authored VR180, VR360, or future volumetric
   content.

Every level must retain a safe fallback to the previous level. Spatial
processing must never be required before an ordinary reel can be watched.

## World Shell MVP

### Generation

- Select a representative keyframe and allow creator override.
- Identify the source frame's focal region and boundary.
- Generate one panorama, cubemap, or inside-facing environment texture.
- Optionally create a few broad depth layers for subtle parallax.
- Generate during upload through the existing job, quote, and credit system.
- Store a fallback poster plus generation provenance.

### Playback

- Keep the original reel unchanged as the central authoritative source.
- Render one static shell rather than decoding a second background video.
- Maintain a stable horizon or ground reference.
- Do not move, roll, shake, or fly the user's camera automatically.
- Fade the shell during transitions.
- Disable shell motion and parallax in reduced-motion mode.
- Provide immediate `ENTER WORLD`, `EXIT WORLD`, and fallback controls.

### Truthfulness

- Show an `AI-EXTENDED ENVIRONMENT` indicator.
- Preserve an inspectable distinction between original and generated regions.
- Store the source keyframe, model/version, time, and safety result.
- Never represent generated surroundings as captured reality.

### Performance gate

The shell must not ship if it materially worsens frame pacing, video motion,
thermal behavior, memory, or session stability. The first version should be one
static texture and draw path, not generated background video.

## Required media contract

The current player infers SBS content from filenames and folder names at
`ui/assets/reels.html:3169`. That is too fragile for multiple immersive
formats.

The media record should distinguish:

```json
{
  "projection": "flat | equirect_180 | equirect_360 | cubemap",
  "stereo_layout": "mono | side_by_side | top_bottom",
  "presentation": "panel | curved_panel | dome | world_shell",
  "orientation": { "yaw_degrees": 0 },
  "comfort_profile": "comfort | cinema | immersive",
  "renditions": [],
  "caption_tracks": [],
  "audio_description_tracks": [],
  "generated_assets": [],
  "provenance": {}
}
```

Publication should validate these values. Playback should automatically select
a compatible rendition and fall back to mono flat mode when necessary.
Filename detection may remain temporarily only for legacy migration.

## Comfort and accessibility findings

The current immersive screen defaults to position `(0, 1.52, -2.24)`, scale
`4.0`, and head lock at `ui/assets/webxr_vr.js:258`. If those units map to
metres, it spans approximately 84 degrees horizontally at that distance. At
`ui/assets/webxr_vr.js:549`, the screen copies the viewer's complete head
orientation.

Recommended direction:

- Make stable world- or body-lock the default.
- Keep direct head lock as an optional focus/accessibility mode.
- If automatic following remains, test delayed yaw-only following with a stable
  horizon.
- Add recenter at all times.
- Offer `COMFORT`, `CINEMA`, and `IMMERSIVE` size presets.
- Test an approximately 45–60 degree default before retaining the current wider
  view as an optional immersive preset.
- Keep required controls near the central view.
- Validate text and target sizes inside the headset.
- Support seated and one-handed operation.
- Add natural session breaks through Reel Pack endings.

Exact geometry must be selected through physical-device comfort testing.

## Captions and translation

The note's translation idea is high-value. The current `caption` field is post
description text, not a timed subtitle system.

Recommended scope:

- Timed caption/subtitle tracks.
- Optional upload-time transcription.
- Viewer-selected translation while retaining original audio.
- Adjustable text size, position, contrast, and background opacity.
- Speaker identification and important non-speech sound labels.
- Mono audio and future audio-description support.

This should be implemented before voice-generated environments. Voice commands
must remain optional and visibly indicate when listening.

## Reel Packs

The first Reel Pack contract should include:

- Stable ID and canonical URL.
- Title, description, cover, creator, tags, and optional location.
- Five to twelve ordered post references.
- Public, unlisted, private, and future subscriber visibility.
- Opening and final cards.
- Resume position.
- Explicit next, previous, exit, and creator actions.
- A finite completion state without forced transition into an endless feed.

Profiles, Explore, Earth, links, QR sharing, and direct messages should all open
the same pack player rather than creating separate playback implementations.

## Earth mode direction

Earth should be positioned as:

> **Drop into what people recently experienced in a place.**

Recommended extensions:

- City and event Reel Packs.
- Verified venue and tourism collections.
- Creator/community-controlled “come home” diaspora collections.
- Today, week, and month windows.
- Clear empty and low-activity states.
- Continued city-level privacy.
- Content-safety filtering before globe previews appear.

Do not add general mapping, navigation, or copied Street View imagery.

## Commercial pilot order

1. Property, hospitality, studios, and creator-space tours.
2. Travel, restaurants, and city experiences connected to Earth.
3. Rights-cleared music and artist experiences.
4. Sports after fast-motion playback and broadcast rights are proven.
5. Curated education/history with explicit reconstruction labels.
6. Private memory packs only after consent and deletion controls mature.

## Social and recommendation direction

Time-synchronized comments already capture the note's “stadium conversation”
idea. Keep them optional, moderated, and performance-bounded.

A later party mode should begin with invitations through existing messaging and
synchronize reel identity, play/pause, seek, and pack position. Rendering should
remain local. Open voice rooms and avatars are unnecessary for the first
version.

Recommendations should optimize for satisfaction, saves, follows, explicit
preference, and diversity—not maximum time spent. Preserve visible negative
feedback and personalization controls. Do not collect gaze, room, biometric, or
private-memory data for advertising or recommendation ranking.

## Monetization direction

The coherent business model is useful processing and premium presentation:

- Credits for optional stereo and World Shell generation.
- Creator/pro exports and archival renditions.
- Property, hospitality, tourism, venue, and brand packages.
- Rights-cleared sponsored Reel Packs with prominent disclosure.
- Later creator revenue sharing based on validated, fraud-resistant engagement.

Avoid opaque “fake credits,” gambling-like purchase loops, unlicensed media,
raw-view compensation before anti-fraud controls, and cryptocurrency complexity.

## Technical findings that control the order

### Playback first

At `ui/assets/webxr_vr.js:3084`, sources at least 3000 pixels wide start at
texture-upload stride 2. A 30fps source can therefore present only about 15
updated video frames per second; adaptive stride 3 can reduce that toward 10.

Before adding World Shells or richer overlays:

- Complete the controlled physical-Quest rendition matrix.
- Identify the actual cause of choppy motion.
- Select a validated browser/headset rendition automatically.
- Present every decoded source frame in the normal path.
- Measure buffering separately from render/upload timing.
- Disable optional readback, overlay, and preload work during baseline tests.

### Preload caveat

The playback investigation's statement that blob URLs never evict is stale.
Current code prunes and revokes them at `ui/assets/reels.html:1981` and aborts
the explicit preload controller when feed work is abandoned.

A hidden `preload="auto"` video remains at `ui/assets/reels.html:1435`, and
`preloadNext()` starts it at `ui/assets/reels.html:3048`. It can still compete
with active network and decode work and should be measured during XR.

### Documentation drift

The Earth plan says rotation is yaw-only, while the current renderer includes an
axis-locked pitch path at `ui/assets/webxr_vr.js:5188`. Current code was treated
as the implementation source of truth; progress documents were used for
rationale and historical validation.

### Release safety

`docs/to-beta.md` still lists blockers involving processing authentication,
job and media ownership, quotas, bounded queues, recommendation concurrency,
retention, deletion, abuse controls, storage, monitoring, and device testing.
A new paid generative feature would increase both cost and moderation exposure,
so these blockers remain ahead of new spectacle.

## Permanent product exclusions

- No stolen or unlicensed media, music, likenesses, or venue footage.
- No casino-style compulsion, attention degradation, or maximum-session-time
  objective.
- No product goal of “blacking out” ordinary life.
- No deceptive fake memories, fake news, fake eyewitness footage, or undisclosed
  AI reconstruction.
- No weapon, drone-strike, soldier, or child-soldier conditioning.
- No trauma, death, psychosis, or phobia content optimized for involuntary
  bodily impact.
- No sale of gaze, room, biometric, private-memory, or sensitive behavior data.
- No automated accounts masquerading as humans.
- No false sensor claims; artistic thermal or EMF effects must be labeled.
- No public exposure of precise private location data.

Fiction and artistic reconstruction can exist when clearly labeled. The
excluded element is deception, exploitation, or non-consensual use.

## Recommended execution order

The detailed checklist is maintained in [todolist.md](todolist.md).

1. Stabilize Quest playback and complete release-safety blockers.
2. Add an explicit immersive-media and rendition contract.
3. Build a static, truthful World Shell proof of concept.
4. Correct anchoring and add comfort/accessibility features.
5. Add Reel Packs and connect them to Earth.
6. Pilot property and travel experiences.
7. Add selective shared viewing and voice navigation later.
8. Keep Gaussian splats, live worlds, physical venues, and hardware as research.

## Acceptance criteria

### Technical

- Stable physical-device XR pacing at the selected refresh rate.
- Every decoded frame presented during normal playback.
- No sustained post-startup buffering on the reference connection.
- Automatic, metadata-driven rendition selection.
- World Shell uses no second video decoder and adds no material pacing
  regression.
- Stable memory and bounded cache behavior through a long session.

### Comfort and accessibility

- Stable horizon and no involuntary camera movement.
- Comfortable world/body-lock default with immediate recenter.
- Core controls usable seated and one-handed.
- Reduced-motion fallback for every immersive enhancement.
- Adjustable captions and non-audio alternatives for important cues.

### Product

- Original reels play without waiting for generation.
- Users understand `ENTER WORLD` before activating it.
- Entry, exit, completion, and comfort-exit rates are measurable.
- Packs have a meaningful ending and return path.
- Earth-to-pack discovery works without exposing precise coordinates.
- Creator generation cost and viewer delivery cost remain bounded.

### Trust and safety

- Generated regions and reconstructions are identifiable.
- Rights and consent are recorded for commercial pilots.
- Reports, blocks, deletion, and moderation cover immersive assets and packs.
- Rewards resist replay and view farming.
- No gaze or biometric advertising profile is introduced.

## Final recommendation

The note's valuable core insight is that ordinary media can become the entrance
to a larger spatial experience. ECHO is already well aligned with that idea.

The right next product direction is therefore not a generalized synthetic
reality platform. It is a reliable, comfortable, truthful progression from
ordinary reel to spatial reel to optional World Shell, packaged into finite
creator-authored experiences and connected through the existing Earth and social
systems.
