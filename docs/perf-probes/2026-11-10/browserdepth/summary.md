# Depth estimation in the browser (onnxruntime-web)

Date: 2026-11-10. Branch `ondevicespatial`. Laptop: Apple M1 Pro, headless Chrome 156, onnxruntime-web 1.31.1.
Model: Video-Depth-Anything-Small, fp32, 518x518, 32-frame windows (22 new frames each).

## Export (`export_onnx.py`)

| form | size | max disparity error vs PyTorch (px at eye width) |
|---|---|---|
| single file | 116 MB | 0.007 (1080 clips), 0.014 (2046-px eye) |
| split: per-frame encoder + 32-frame head (`--split`) | 88 + 28 MB | same |

Mean and p99 error are 0.000 px; p99.9 is at most 0.002 px. Results: `export_check.json`, `export_check_split.json`.
The first export was 678 MB: `baddbmm(torch.empty(...), beta=0)` in the motion-module attention was saved as zero constants. The export swaps in the same maths without the empty tensor (the vendored code is unchanged).
The browser needs the split form: DINOv2 attention over all 32 frames at once is 1.4 GB.

## Speed (`bench.html`, results `bench_webgpu.json`, `bench_wasm.json`)

| backend | encoder ms/frame | head ms/window | depth fps |
|---|---|---|---|
| WebGPU | 152 | 1434 | 4.6 |
| WASM, 8 threads | 1430 | 9235 | 0.54 |

depth fps = 22 / (22 x encoder + head). Target for live playback: about 24.

## Quest 3 estimate (not measured)

Naive f32 matmul in WebGPU (`../depthwarp/quest_webgpu.html`): Quest 3 32-47 GFLOPS, this laptop 56-164 GFLOPS (`laptop_gpu.json`, `../depthwarp/quest_gpu.json`), a ratio of 1.7-3.5x.
Scaled from 4.6 fps: about 1.3-2.7 depth fps on the Quest. This is crude: ort-web efficiency on Adreno is unmeasured, and the head does not load as exported (its largest attention buffer is about 180 MB; the Quest binds at most 128 MB).

## Verdict

No-go for full-rate depth in the browser at 518 px, fp32: 5x under target on the laptop, 10-20x under on the Quest.
For reference, the server does a 5 s clip's depth in 13-23 s on MPS; the laptop browser would take about 33 s.
fp16 and keeping features on the GPU are each worth 1.3-2x at best. A 364-px export (676 tokens instead of 1369) would speed the encoder about 2.5x, for about 9 fps on the laptop, with the head then the main cost.
Instagram runs its depth model natively on the NPU; the browser has no path to the NPU.
