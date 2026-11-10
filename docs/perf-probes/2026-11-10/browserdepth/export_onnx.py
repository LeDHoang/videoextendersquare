#!/usr/bin/env python3
"""Export Video-Depth-Anything-Small to ONNX for the browser, and check it
against PyTorch on the depthwarp clips.

The model's forward pass takes one 32-frame window at 518x518 (the square
clips' depth size): (1, 32, 3, 518, 518) normalized RGB -> (1, 32, 518, 518)
raw depth. The window stitching (overlap 10, scale/shift alignment) stays in
the caller, as in infer_video_depth; the browser will do it in JS.

Check: run infer_video_depth twice per clip, once with PyTorch's forward and
once with the ONNX forward, normalize each by its own shot range (as the
pipeline does) and report the nearness difference in pixels of disparity at
the eye width (nearness 1.0 = MAX_SHIFT * eye px).

--split exports and checks the browser's form instead: a per-frame encoder
and a 32-frame temporal head (see split_modules).

usage: export_onnx.py --out <dir> --work <clips dir> [--pylib <onnx site dir>]
       [--clips street tron lyrics street4k] [--skip-export] [--split]
Run from the repo root with the main venv (needs .models/video_depth_anything_vits.pth).
"""
import argparse, json, os, sys, time

import numpy as np

sys.path.insert(0, os.getcwd())
import pipeline.spatial_worker as sw  # noqa: E402

T, SIZE = 32, 518
EYES = {"street": 1048, "tron": 1048, "lyrics": 1048, "street4k": 2046}


def load_model():
    import torch
    sw._pick_device = lambda: "cpu"  # export and the reference run in fp32 on the CPU
    model, _ = sw._depth_model()
    return model.float().eval(), torch


def _attention_no_empty(self, query, key, value, attention_mask=None):
    """CrossAttention._attention without baddbmm(torch.empty(...), beta=0):
    the exporter folds that empty tensor into a zero constant per call
    (560 MB of the first export). Same maths: scale * q @ k^T."""
    scores = (query @ key.transpose(-1, -2)) * self.scale
    if attention_mask is not None:
        scores = scores + attention_mask
    return self.reshape_batch_dim_to_heads(scores.softmax(dim=-1).to(value.dtype) @ value)


def split_modules(model, torch):
    """(encoder, head): DINOv2 on one frame (1, 3, 518, 518) -> its 4 token
    layers (1, 1369, 384); the temporal DPT head on a window's 4 stacked
    layers (32, 1369, 384) -> depth (1, 32, 518, 518). Composed, they are
    VideoDepthAnything.forward. The split keeps every WebGPU buffer small
    (one frame's DINOv2 attention instead of 32 frames' 1.4 GB) and lets the
    browser run the encoder as frames arrive."""
    import torch.nn.functional as F
    patches = SIZE // 14
    layers = model.intermediate_layer_idx[model.encoder]

    class Encoder(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.m = model.pretrained  # a submodule, so the tracer sees its weights as parameters

        def forward(self, x):
            return tuple(f[0] for f in self.m.get_intermediate_layers(x, layers, return_class_token=True))

    class Head(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.m = model.head

        def forward(self, f1, f2, f3, f4):
            feats = [(f, f[:, 0]) for f in (f1, f2, f3, f4)]  # class token unused (use_clstoken False)
            depth = self.m(feats, patches, patches, T)[0]
            depth = F.relu(F.interpolate(depth, size=(SIZE, SIZE), mode="bilinear", align_corners=True))
            return depth.squeeze(1).unflatten(0, (1, T))

    return Encoder().eval(), Head().eval()


def export(model, torch, paths):
    from pipeline.third_party.video_depth_anything.motion_module.attention import CrossAttention
    original, CrossAttention._attention = CrossAttention._attention, _attention_no_empty
    enc, head = split_modules(model, torch)
    tokens = (SIZE // 14) ** 2
    jobs = {
        "full": (model, (torch.randn(1, T, 3, SIZE, SIZE),), ["x"], ["depth"]),
        "encoder": (enc, (torch.randn(1, 3, SIZE, SIZE),), ["x"], ["f1", "f2", "f3", "f4"]),
        "head": (head, tuple(torch.randn(T, tokens, 384) for _ in range(4)), ["f1", "f2", "f3", "f4"], ["depth"]),
    }
    t = time.time()
    try:
        for key, path in paths.items():
            module, args, ins, outs = jobs[key]
            torch.onnx.export(module, args, path, input_names=ins, output_names=outs,
                              opset_version=17, dynamo=False, do_constant_folding=True)
    finally:
        CrossAttention._attention = original  # the PyTorch reference runs the vendored code
    return time.time() - t


def disparity_px(a, b, eye):
    """Mean / p99 / p99.9 / max |nearness(a) - nearness(b)| in px at eye width."""
    na = sw.normalize_depth(a, *sw.shot_range(a)).astype(np.float32)
    nb = sw.normalize_depth(b, *sw.shot_range(b)).astype(np.float32)
    d = np.abs(na - nb) * sw.MAX_SHIFT * eye
    return {k: round(float(v), 4) for k, v in
            zip(["mean", "p99", "p999", "max"], [d.mean(), *np.percentile(d, [99, 99.9]), d.max()])}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--pylib", help="extra site dir holding onnx/onnxruntime (appended, so the venv wins)")
    ap.add_argument("--clips", nargs="+", default=list(EYES))
    ap.add_argument("--skip-export", action="store_true")
    ap.add_argument("--split", action="store_true", help="check encoder + head instead of the single file")
    a = ap.parse_args()
    if a.pylib:
        sys.path.append(a.pylib)
    import onnxruntime as ort

    os.makedirs(a.out, exist_ok=True)
    keys = ["encoder", "head"] if a.split else ["full"]
    names = {"full": f"vda_small_t{T}_{SIZE}.onnx", "encoder": f"vda_small_encoder_{SIZE}.onnx",
             "head": f"vda_small_head_t{T}_{SIZE}.onnx"}
    paths = {k: os.path.join(a.out, names[k]) for k in keys}
    model, torch = load_model()
    report = {"T": T, "size": SIZE, "torch": torch.__version__, "ort": ort.__version__, "split": a.split}
    if not a.skip_export:
        report["export_s"] = round(export(model, torch, paths), 1)
    report["onnx_mb"] = {k: round(os.path.getsize(p) / 1e6, 1) for k, p in paths.items()}

    sess = {k: ort.InferenceSession(p, providers=["CPUExecutionProvider"]) for k, p in paths.items()}
    torch_forward = model.forward
    onnx_ms = []

    def onnx_forward(x):
        t = time.time()
        x = x.cpu().numpy().astype(np.float32)
        if a.split:
            per_frame = [sess["encoder"].run(None, {"x": x[:, i]}) for i in range(T)]
            feats = {f"f{j + 1}": np.concatenate([p[j] for p in per_frame]) for j in range(4)}
            y = sess["head"].run(None, feats)[0]
        else:
            y = sess["full"].run(None, {"x": x})[0]
        onnx_ms.append((time.time() - t) * 1000)
        return torch.from_numpy(y)

    report["clips"] = {}
    for name in a.clips:
        src = os.path.join(a.work, f"{name}.src.mp4")
        frames = list(sw._decode(src, SIZE, SIZE, "bt709"))
        t = time.time()
        ref, _ = model.infer_video_depth(frames, 30.0, input_size=SIZE, device="cpu", fp32=True)
        torch_s = time.time() - t
        model.forward = onnx_forward
        onnx_ms.clear()
        t = time.time()
        got, _ = model.infer_video_depth(frames, 30.0, input_size=SIZE, device="cpu", fp32=True)
        onnx_s = time.time() - t
        model.forward = torch_forward
        raw_rel = float(np.abs(ref - got).max() / max(np.abs(ref).max(), 1e-6))
        row = {"frames": len(frames), "torch_cpu_s": round(torch_s, 1), "onnx_cpu_s": round(onnx_s, 1),
               "onnx_ms_per_window": round(float(np.median(onnx_ms)), 0),
               "raw_max_rel": round(raw_rel, 6), "disparity_px": disparity_px(ref, got, EYES[name])}
        report["clips"][name] = row
        print(name, json.dumps(row), flush=True)

    with open(os.path.join(a.out, f"export_check{'_split' if a.split else ''}.json"), "w") as fh:
        json.dump(report, fh, indent=1)
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
