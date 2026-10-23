# Vendored: Video-Depth-Anything

- Upstream: https://github.com/DepthAnything/Video-Depth-Anything
- Commit: `4f5ae23172ba60fd7bc11ef671cca678842c7072` (2025-10-07); the package
  itself last changed in `087302660e348235e8bf54194ffb7eab95c39aae`.
- Licence: Apache-2.0 (`LICENSE`, copied from the upstream repository root).
  Only the Small (`vits`) checkpoint is Apache-2.0; Base and Large weights are
  CC-BY-NC-4.0, so `pipeline/spatial_worker.py` pins `DEPTH_ENCODER = "vits"`.
- Why vendored: upstream has no `setup.py`/`pyproject.toml`, so it cannot be
  pip-installed at a pinned version.

## What was copied

`video_depth_anything/` minus `video_depth_stream.py` (unused), plus
`utils/util.py` from the repository root as `util/util.py` (the two helpers
`video_depth.py` imports).

## Local edits

1. `video_depth.py`: `from utils.util import ...` became
   `from .util.util import ...` so the package imports from any path.
2. `video_depth.py`: `range(frames.shape[0])` became `range(len(frames))` so
   `infer_video_depth` accepts a list of frames (no stacked copy of a clip).
3. `dinov2_layers/attention.py`: `Attention.forward` uses
   `torch.nn.functional.scaled_dot_product_attention` instead of the explicit
   `q @ k^T` softmax. Same maths; `tests/test_spatial_real_depth.py` checks it
   against the original formula.

Nothing else differs from upstream; `diff -r` against the commit above shows
only these lines.
