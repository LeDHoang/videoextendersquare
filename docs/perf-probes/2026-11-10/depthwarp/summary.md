# Old (baked right eye) vs new (colour + depth, warped at playback)

Date: 2026-11-10. Branch `ondevicespatial`. Machine: Apple MPS, Video-Depth-Anything-Small.
Reproduce: `compare.py --work <dir> --clips ...`, then `serve.py` + `harness.html` + `compare.py --gpu-check`.
Raw numbers: `summary.json`. Crops: `crops/*.png` (source, clean and decoded depth, old L/R/anaglyph, new L/R/anaglyph, old holes, new stretch and unconverged masks, at the frame of densest depth edges).

Both modes use production settings: H.264 CRF 20, full SBS, defaults of `process_video_spatial`.
Timing is the faster of two interleaved runs per mode. Clips: 5 s at 1080 (eye 1048 px) and 3 s of the 3840 source (eye 2046 px).

## Conversion time

| clip | old | new | speedup | old ms/frame | new ms/frame |
|---|---|---|---|---|---|
| street 1080 | 69.3 s | 22.4 s | 3.1x | 462 | 149 |
| tron 1080 | 65.0 s | 21.1 s | 3.1x | 434 | 141 |
| lyrics 1080 | 77.5 s | 26.9 s | 2.9x | 516 | 179 |
| street 2046-px eye | 144.7 s | 25.7 s | 5.6x | 1608 | 285 |

The old right-eye render is 45-47 s of a 5 s 1080 clip and 122 s of the 3 s full-res clip. The new mode skips it, so depth estimation (13-23 s) is almost all of the remaining time. Depth cost does not grow with output size (it runs at 518 px), so the new mode's advantage grows with resolution.

New files are 71-80% of the old size (the right half is a flat grey map instead of a second picture).

## Quality

Disparity numbers are in pixels at the eye width; nearness 1.0 equals `MAX_SHIFT * eye` px (14.5 px at 1048).

| | street | tron | lyrics | street 2046 |
|---|---|---|---|---|
| depth codec error at edges, mean / p99 | 0.09 / 0.56 | 0.13 / 0.74 | 0.11 / 0.64 | 0.20 / 0.65 |
| depth flicker at edges, mean / p99 | 0.10 / 0.64 | 0.16 / 0.91 | 0.13 / 0.75 | 0.12 / 0.62 |
| colour PSNR new / old right eye (dB) | 40.0 / 39.4 | 41.9 / 41.0 | 41.4 / 40.7 | 38.1 / 37.7 |
| old right eye vs new warp, all / edges (dB) | 54.8 / 46.9 | 45.8 / 36.7 | 45.4 / n/a | 45.9 / 41.5 |
| old: hole pixels filled by background_fill | 0.03% | 0.23% | 0.32% | 0.07% |
| new: lookup runs backwards (fold) | 0.01% | 0.06% | 0.10% | 0.00% |
| new: fixed-point lookup unconverged | 0.06% | 0.29% | 0.46% | 0.20% |

- Depth survives H.264: mean error 0.02 px in flat areas and about 0.1-0.2 px at edges; the worst case is 2.4 px at a few pixels.
- The colour/depth seam bleeds into the first depth column (error 0.08-0.09 px against 0.02 px inside) and into the colour columns beside the seam (about 1 grey level worse). Both are small.
- New eyes built from decoded depth are 61-68 dB from eyes built from clean depth at 1080 and 49 dB at 2046 px: compression of the depth is not visible.
- The numpy port matches the real shader on the GPU (street frame 30, browser-decoded): 60 dB, 99th-percentile error 0.5 grey level, both eyes.
- Old right-eye PSNR against the new warp falls to 37-47 dB at depth edges: the methods place disoccluded content differently (old copies mirrored background; new stretches the edge pixel).

## Caveats

- Total parallax between the eyes is the same in both modes (old: right eye shifted by the full amount; new: each eye by half), but the old shift is a fraction of the uncropped render width and the new one of the eye width, so the new mode has about 2.8% less depth.
- The warp's "stretch" count (one source pixel over more than 2 output pixels) was 0.65-0.81%, against 0.03-0.24% for the old splat. It was not checked how much of it is clamped border columns, so it is left out of the table; fold and unconverged are the depth-edge measures.
- One lyrics frame had no depth edges, so its edge-average is empty.
- 4:2:0 chroma is shared across the seam; the seam bleed numbers above are the cost.
- Not measured: playback cost on the Quest (the headset is shared with another agent), and subjective comfort. A Quest A/B is the next check.
- 30 sampled frames per 1080 clip and 18 for the full-res clip (every 10th frame and its successor); clips are 3-5 s, so scene cuts and long-shot drift are not covered.
