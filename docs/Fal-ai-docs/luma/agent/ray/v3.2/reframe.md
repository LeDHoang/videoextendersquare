# Luma Ray 3.2 Reframe

> Summary of the fal.ai model page and API schema, checked 2026-10-20. Replaces
> `fal-ai/luma-dream-machine/ray-2-flash/reframe` (deprecated by fal on 2026-10-25).

## Overview

- **Endpoint**: `https://fal.run/luma/agent/ray/v3.2/reframe`
- **Model ID**: `luma/agent/ray/v3.2/reframe`
- **Category**: video-to-video
- **Sources**: https://fal.ai/models/luma/agent/ray/v3.2/reframe and https://fal.ai/models/luma/agent/ray/v3.2/reframe/api

## Pricing

Billed per started source second, by output resolution:

- 540p: $0.06 per second
- 720p: $0.12 per second
- 1080p: $0.36 per second

## Input Schema

- `prompt` (string, required): what to paint into the newly exposed canvas.
- `video_url` (string, required): source video. The source must be 10 seconds or less.
- `aspect_ratio` (enum, required): `3:4`, `4:3`, `1:1`, `9:16`, `16:9`, `21:9`.
- `resolution` (enum, optional, default `540p`): `540p`, `720p`, `1080p`.
- `duration` (enum, optional): `5s`, `10s`. Defaults to the source duration.
- `source_position` (object, optional): normalized rectangle (`x_norm`, `y_norm`, `w_norm`, `h_norm`, all required when set) placing the source in the output canvas.
- `enable_safety_checker` (boolean, optional, default `true`).

## Output Schema

- `video` (File, required): `url`, `content_type`, `file_name`, `file_size`.
- `exr_file` (File, optional): EXR sidecar.

## How this repo calls it

`pipeline/video_worker.py` sends `video_url`, `prompt` (default prompt when blank),
`aspect_ratio: "1:1"` and `resolution` (`luma_resolution`, default `720p`). It omits
`duration` so the output follows the source. Sources over 10 s are refused by the
quote (`core/pricing.py`), the `/api/video/process` route and the worker.
