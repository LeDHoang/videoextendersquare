# Ltx 2.3 Quality

> Outpaint high-quality video using LTX-2.3 


## Overview

- **Endpoint**: `https://fal.run/fal-ai/ltx-2.3-quality/outpaint`
- **Model ID**: `fal-ai/ltx-2.3-quality/outpaint`
- **Category**: video-to-video
- **Kind**: inference
**Tags**: outpaint, outpainting



## Pricing

Your request will cost $0.0024075 per megapixel of generated video data (width × height × frames), rounded up. For example, if you generate a video that is 121 frames long at 1280 × 720, your total generated video is ≈112 MP, and your request will cost $0.2696.

For more details, see [fal.ai pricing](https://fal.ai/pricing).

## API Information

This model can be used via our HTTP API or more conveniently via our client libraries.
See the input and output schema below, as well as the usage examples.


### Input Schema

The API accepts the following input parameters:


- **`prompt`** (`string`, _required_):
  The prompt to guide the outpainted video generation.
  - Examples: "A cinematic wide shot of the same scene, extending the environment naturally beyond the original frame."

- **`video_url`** (`string`, _required_):
  The source video to spatially outpaint.

- **`aspect_ratio`** (`AspectRatioEnum`, _optional_):
  Target aspect ratio for the outpainted video. Choose a different ratio than the input video to extend the frame cleanly, e.g. use 16:9 for a 4:3 source. Default value: `"16:9"`
  - Default: `"16:9"`
  - Options: `"21:9"`, `"16:9"`, `"4:3"`, `"1:1"`, `"3:4"`, `"9:16"`, `"9:21"`

- **`output_resolution`** (`OutputResolutionEnum`, _optional_):
  Output resolution tier. 480p is faster, 720p is the default balance, and 1080p gives a larger canvas when it fits LTX limits. Default value: `"720p"`
  - Default: `"720p"`
  - Options: `"480p"`, `"720p"`, `"1080p"`

- **`resolution`** (`ImageSize | Enum`, _optional_):
  Legacy exact target canvas size. For new requests, prefer aspect_ratio with output_resolution; this field remains supported for backwards compatibility. Default value: `landscape_16_9`
  - Default: `"landscape_16_9"`
  - One of: ImageSize | Enum

- **`source_scale`** (`float`, _optional_):
  Scale of the source video inside the target canvas before outpainting. 1.0 uses the largest source size that fits the target canvas, which is recommended for true aspect-ratio outpainting such as 4:3 to 16:9. Lower values create a zoom-out border around the source and are less stable. Default value: `1`
  - Default: `1`
  - Range: `0.25` to `1`

- **`video_strength`** (`float`, _optional_):
  Strength of the IC-LoRA video guide for the original content. Higher values preserve the source video more strongly inside the outpainted canvas. Default value: `1`
  - Default: `1`
  - Range: `0` to `1`

- **`num_frames`** (`integer`, _optional_):
  The number of frames to generate. Default value: `121`
  - Default: `121`
  - Range: `9` to `481`

- **`frames_per_second`** (`float`, _optional_):
  Frames per second of the generated video. Default value: `24`
  - Default: `24`
  - Range: `1` to `60`

- **`num_inference_steps`** (`integer`, _optional_):
  Number of inference steps. Defaults to 15 and can be increased up to 30. Default value: `15`
  - Default: `15`
  - Range: `8` to `30`

- **`guidance_scale`** (`float`, _optional_):
  Classifier-free guidance scale. The default is tuned for fast, high-quality generation. Default value: `1`
  - Default: `1`
  - Range: `1` to `20`

- **`generate_audio`** (`boolean`, _optional_):
  Whether to include audio in the returned video. When disabled, the final MP4 is returned without an audio track. Default value: `true`
  - Default: `true`

- **`negative_prompt`** (`string`, _optional_):
  The negative prompt to steer generation away from. Default value: `"color distortion, overexposure, static, blurry details, subtitles, style, artwork, painting, frame, still, dim overall tone, worst quality, low quality, JPEG compression artifacts, ugly, mutilated, extra fingers, poorly drawn hands, poorly drawn face, deformed, disfigured, malformed limbs, fused fingers, motionless frame, cluttered background, three legs, crowded background, walking backwards"`
  - Default: `"color distortion, overexposure, static, blurry details, subtitles, style, artwork, painting, frame, still, dim overall tone, worst quality, low quality, JPEG compression artifacts, ugly, mutilated, extra fingers, poorly drawn hands, poorly drawn face, deformed, disfigured, malformed limbs, fused fingers, motionless frame, cluttered background, three legs, crowded background, walking backwards"`

- **`seed`** (`integer`, _optional_):
  Random seed for reproducibility. If None, a random seed is chosen.

- **`enable_prompt_expansion`** (`boolean`, _optional_):
  Whether to enable prompt expansion. Default value: `true`
  - Default: `true`

- **`enable_safety_checker`** (`boolean`, _optional_):
  Whether to enable the safety checker. Default value: `true`
  - Default: `true`

- **`video_quality`** (`VideoQualityEnum`, _optional_):
  The quality preset of the generated video. Default value: `"high"`
  - Default: `"high"`
  - Options: `"low"`, `"medium"`, `"high"`, `"maximum"`

- **`video_write_mode`** (`VideoWriteModeEnum`, _optional_):
  The write mode of the generated video. Default value: `"balanced"`
  - Default: `"balanced"`
  - Options: `"fast"`, `"balanced"`, `"small"`

- **`sync_mode`** (`boolean`, _optional_):
  If True, the media is returned as a data URI inline in the response. Useful for short-lived requests and tests.
  - Default: `false`



**Required Parameters Example**:

```json
{
  "prompt": "A cinematic wide shot of the same scene, extending the environment naturally beyond the original frame.",
  "video_url": ""
}
```

**Full Example**:

```json
{
  "prompt": "A cinematic wide shot of the same scene, extending the environment naturally beyond the original frame.",
  "video_url": "",
  "aspect_ratio": "16:9",
  "output_resolution": "720p",
  "resolution": "landscape_16_9",
  "source_scale": 1,
  "video_strength": 1,
  "num_frames": 121,
  "frames_per_second": 24,
  "num_inference_steps": 15,
  "guidance_scale": 1,
  "generate_audio": true,
  "negative_prompt": "color distortion, overexposure, static, blurry details, subtitles, style, artwork, painting, frame, still, dim overall tone, worst quality, low quality, JPEG compression artifacts, ugly, mutilated, extra fingers, poorly drawn hands, poorly drawn face, deformed, disfigured, malformed limbs, fused fingers, motionless frame, cluttered background, three legs, crowded background, walking backwards",
  "enable_prompt_expansion": true,
  "enable_safety_checker": true,
  "video_quality": "high",
  "video_write_mode": "balanced"
}
```


### Output Schema

The API returns the following output format:

- **`video`** (`File`, _required_):
  The generated video.

- **`seed`** (`integer`, _required_):
  The seed actually used for generation.

- **`prompt`** (`string`, _required_):
  The prompt used for generation (after any expansion).



**Example Response**:

```json
{
  "video": {
    "url": "",
    "content_type": "image/png",
    "file_name": "z9RV14K95DvU.png",
    "file_size": 4404019
  },
  "prompt": ""
}
```


## Usage Examples

### cURL

```bash
curl --request POST \
  --url https://fal.run/fal-ai/ltx-2.3-quality/outpaint \
  --header "Authorization: Key $FAL_KEY" \
  --header "Content-Type: application/json" \
  --data '{
     "prompt": "A cinematic wide shot of the same scene, extending the environment naturally beyond the original frame.",
     "video_url": ""
   }'
```

### Python

Ensure you have the Python client installed:

```bash
pip install fal-client
```

Then use the API client to make requests:

```python
import fal_client

def on_queue_update(update):
    if isinstance(update, fal_client.InProgress):
        for log in update.logs:
           print(log["message"])

result = fal_client.subscribe(
    "fal-ai/ltx-2.3-quality/outpaint",
    arguments={
        "prompt": "A cinematic wide shot of the same scene, extending the environment naturally beyond the original frame.",
        "video_url": ""
    },
    with_logs=True,
    on_queue_update=on_queue_update,
)
print(result)
```

### JavaScript

Ensure you have the JavaScript client installed:

```bash
npm install --save @fal-ai/client
```

Then use the API client to make requests:

```javascript
import { fal } from "@fal-ai/client";

const result = await fal.subscribe("fal-ai/ltx-2.3-quality/outpaint", {
  input: {
    prompt: "A cinematic wide shot of the same scene, extending the environment naturally beyond the original frame.",
    video_url: ""
  },
  logs: true,
  onQueueUpdate: (update) => {
    if (update.status === "IN_PROGRESS") {
      update.logs.map((log) => log.message).forEach(console.log);
    }
  },
});
console.log(result.data);
console.log(result.requestId);
```


## Additional Resources

### Documentation

- [Model Playground](https://fal.ai/models/fal-ai/ltx-2.3-quality/outpaint)
- [API Documentation](https://fal.ai/models/fal-ai/ltx-2.3-quality/outpaint/api)
- [OpenAPI Schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/ltx-2.3-quality/outpaint)

### fal.ai Platform

- [Platform Documentation](https://docs.fal.ai)
- [Python Client](https://docs.fal.ai/clients/python)
- [JavaScript Client](https://docs.fal.ai/clients/javascript)
