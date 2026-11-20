# Multi-format reels: 1:1, 16:9, 9:16

Reels and images are no longer forced into a square. A post is 1:1, 16:9 or
9:16. With extend off it keeps the native shape of its file, so every
surface also handles odd ratios such as 4:5 or 21:9.

## The aspect field

Every post payload carries `aspect`: the shown width/height of **one eye**
of the **first slide**, rounded to 4 places. It is 1 when the dims are
unknown. `server/social/services.py:post_aspect` makes it, and every payload
builder calls it: feed, cards, packs and messages.

Grids, the 2D player and the VR screen all size themselves from this one
field. Nothing re-derives the shape from width/height on the client. Before
publish, the upload stage uses the same math through
`web/src/components/upload/stageGeometry.js`.
`tests/fixtures/aspect_vectors.json` pins the parity between Python and JS.

Width and height are **display** dims. A rotated phone video is stored as
1080×1920, not as its coded 1920×1080. Images are EXIF-transposed first.
Quote and submit fingerprints bind these dims.

## Shared helpers (`pipeline/utils.py`)

| Helper | Rule |
|---|---|
| `TARGET_ASPECTS` | `("1:1", "16:9", "9:16")` |
| `ASPECT_TOLERANCE` | 1%. It absorbs coded sizes such as 1920×1088. |
| `aspect_matches(w, h, t)` | Within the tolerance of target `t`. |
| `nearest_aspect(w, h)` | Closest target by log ratio. It is the default pick when extend is on. |
| `needs_extend(w, h, t, extend)` | The single "this job outpaints" predicate. Pricing, billing and the workers all use it. |
| `aspect_canvas(w, h, t)` | Smallest even canvas at `t` that holds the source unscaled. |
| `master_size(w, h, t)` | Short side 2048, long side ≤ 4096, even. 2048², 3640×2048, 2048×3640. |
| `budget_size(w, h, px)` | Even size at w:h within `px` pixels. Never upscales. |
| `eye_aspect(w, h, layout)` | Per-eye aspect for `mono`, `sbs` and `tb`. |

## Upload

There are two modes. "Stretch to fit" is gone.

- **Fill with AI:** outpaint to a picked shape (`target_aspect`). The
  default is the nearest shape to the source. The pick is remembered per kind
  for the visit.
- **Keep shape:** nothing is added. Upscale is optional and keeps the native
  ratio.

With extend on and no upscale, the master keeps the native short side and
the target sets the long side.

API callers that still send `upscale_only` keep the old square behaviour.

In a slideshow, slide 0 sets the post shape. Other slides contain-fit with a
letterbox.

## Renditions (`server/media.py`)

Renditions use pixel budgets, so squares keep exactly their old sizes.

| Rendition | Rule |
|---|---|
| Web preview / left-eye 2D | Within 2160² pixels (`MONO_VIDEO_MAX_SIDE`). |
| vr2k | Within 2048² pixels per eye (`vr2k_size`). |
| Explore tile | Short side 720, long side ≤ 1280 (`tile_size`). |
| VR still | Fits a 4096×2048 box. |

## 3D

SBS and TB are stored at full resolution. Each eye is 1:1, 16:9 or 9:16;
there is no half-SBS. The short side is 2048 per eye, so a 16:9-eye SBS frame
is 7280×2048.

Uploads accept the six stereo frame shapes. Detection proposes only 2:1,
32:9, 1:2 and 9:32 frames. The near-square 9:8 and 8:9 frames (SBS of 9:16
eyes, TB of 16:9 eyes) are never auto-picked. For those, use the manual
SBS/TB choice in the dialog.

MAKE 3D / depth_pack accept the three eye shapes. Other shapes are skipped,
not errored, and such a post goes 2D only.

## Grids

`web/src/hooks/useMasonry.js` places tiles greedily into the shortest column.
It reads the column count from the computed `grid-template-columns`. Each tile
gets an explicit `grid-column` and `grid-row: start / span N`. DOM and tab
order stay in item order. When the column count is 1 (phone), no placement is
applied.

Tile aspects are clamped to [9:16, 16:9], and the media cover-fits inside. A
container query in `global.css` hides the title and location on short tiles.

These chips stay square: PackTile, skeletons, avatars, highlight covers,
message previews and queue thumbs.

## 2D player (`ui/assets/reels.html`)

The player slot stays square. The media contain-fits inside it
(`object-fit: contain`) over `.reels-backdrop`, a blurred copy of the poster.
`--sx-media-ar` is set once per post from slide 0. On a phone, a 9:16 reel
fills the width, with blurred bands above and below. Pan is inert under
contain. See `docs/reels-2d-player-layout.md`.

## VR (`ui/assets/webxr_vr.js`)

- **Screen size:** the short side is 2.4 × `screenScale` m, today's square
  side. The long side scales with the aspect. A shape wider than 16:9 or taller
  than 9:16 holds the 16:9 long-side span, so its short side shrinks.
- **Curvature:** the long-axis bend is clamped so the long edges sit within
  `LONG_EDGE_MAX_DEG` (60°) of the eye. A 1:1 screen keeps the old geometry
  vertex for vertex.
- **Aspect source:** `applyEntryStereo` passes the post's `aspect`. It
  resolves at texture commit in this order: static card → 1, else the hint,
  else the intrinsic eye-adjusted dims. The screen never resizes mid-post.
- **Overlay hits:** UVs are remapped to the screen aspect. A hit outside
  [0, 1] is a miss.
- **Lazy follow:** applies to every shape, including 1:1. The screen holds
  still while the gaze stays inside it (`LAZY_FOLLOW_EDGE` × its angular
  half-extent). It drags only once the view centre crosses that edge. Setting
  0 restores the old hard lock.
- **Comfort:** the look-down fade keys on the screen's bottom-edge angle. On
  wide shapes the side panels sit nearer than the screen surface. On 9:16 the
  ground globe fades while the screen bottom is below it.
- **Tuning:** ImmersivePreviewPage exposes "SCREEN SHORT SIDE (M)", the lazy
  follow edge and `LONG_EDGE_MAX_DEG`.

## Pricing

`core/pricing.py` quotes per axis. The model MP formula is `w*h*frames`.
`target_aspect` is a price key. The LTX 2.3 canvas per resolution and aspect
is `core/models.py:LTX_23_CANVAS`. Its 16:9 and 9:16 entries are estimates
until the approved probe jobs measure them.
