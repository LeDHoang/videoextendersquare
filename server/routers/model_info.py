"""Model-info router — live requirements/pricing/schema for fal.ai models.

The sidebar's MODEL ENDPOINTS editor lets users point the pipelines at any
fal.ai model id outside the stock catalog. Those customs show up as
``CUSTOM(...)`` buttons in the extenders, and this endpoint pulls what the
user needs to judge them before spending money:

- requirements (which inputs are required, auth)
- cost (the model's Pricing section, verbatim from fal.ai)
- expected input/output (structured from the model's queue OpenAPI schema)

Both sources are public and keyless:
- ``https://fal.ai/models/<id>/llms.txt`` — title, description, pricing, schemas
- ``https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>`` — structured
  input/output properties + ``info.x-fal-metadata`` (category, playground URL)

Results are cached in-process for an hour per model id. Any fetch/parse
failure returns ``found: False`` with generic pipeline expectations so the UI
can still render a useful (clearly estimated) panel.
"""

from __future__ import annotations

import json
import re
import threading
import time
import urllib.parse
import urllib.request
from html import unescape

from fastapi import APIRouter, Query

from core import models as _models

router = APIRouter(prefix="/api/config", tags=["config"])

_CACHE_TTL_S = 3600.0
_cache: dict[str, tuple[float, dict]] = {}
_cache_lock = threading.Lock()
_FETCH_TIMEOUT_S = 15


def _http_get_text(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "echo-videoextender/2.0"})
    with urllib.request.urlopen(req, timeout=_FETCH_TIMEOUT_S) as res:
        raw = res.read().decode("utf-8", "replace")
    return raw


def _section(md: str, heading: str) -> str:
    """Return the markdown between `heading` (a `## ...` line) and the next
    `## ` heading (or EOF), stripped. Empty string when absent."""
    lines = md.splitlines()
    buf: list[str] = []
    inside = False
    for line in lines:
        if line.startswith("## "):
            if inside:
                break
            if line.strip("# ").strip().lower() == heading.lower():
                inside = True
            continue
        if inside:
            buf.append(line)
    return "\n".join(buf).strip()


def _first_quote(md: str) -> str:
    for line in md.splitlines():
        s = line.strip()
        if s.startswith(">"):
            return unescape(s.lstrip(">").strip())
    return ""


def _title(md: str) -> str:
    for line in md.splitlines():
        s = line.strip()
        if s.startswith("# "):
            return unescape(s[2:].strip())
    return ""


_PARAM_RE = re.compile(
    r"^-\s+\*\*(?P<name>[^*]+)\*\*\s+\(`?(?P<type>[^`)]+)`?(?:,\s*_(?P<req>required|optional)_)?\)?:?\s*(?P<rest>.*)$"
)


def _parse_llms_params(section: str, limit: int = 40) -> list[dict]:
    """Parse the `- **name** (type, _required_)` bullet lists in llms.txt
    schema sections into structured rows (best-effort; unknown lines skipped)."""
    rows: list[dict] = []
    current: dict | None = None
    for line in section.splitlines():
        m = _PARAM_RE.match(line.strip())
        if m:
            if len(rows) >= limit:
                break
            current = {
                "name": m.group("name").strip(),
                "type": m.group("type").strip(),
                "required": (m.group("req") or "optional") == "required",
                "default": "",
                "options": [],
                "detail": (m.group("rest") or "").strip(),
            }
            rows.append(current)
            continue
        s = line.strip()
        if current is not None and s.startswith("- ") and len(s) < 300:
            bit = s[2:].strip()
            if bit and current["detail"]:
                current["detail"] += " " + bit
            elif bit:
                current["detail"] = bit
    for r in rows:
        r["detail"] = r["detail"][:400]
    return rows


def _openapi_io(spec: dict) -> tuple[list[dict], list[dict], dict]:
    """Extract (inputs, outputs, meta) from a queue OpenAPI document."""
    schemas = ((spec.get("components") or {}).get("schemas") or {})
    meta = ((spec.get("info") or {}).get("x-fal-metadata") or {})

    def pick(suffix: str) -> dict:
        cands = [n for n in schemas if suffix in n and "Queue" not in n and "Status" not in n]
        if not cands:
            return {}
        # Prefer the longest (most specific) schema name.
        return schemas[sorted(cands, key=len)[-1]] or {}

    def rows(schema: dict) -> list[dict]:
        props = (schema.get("properties") or {})
        required = set(schema.get("required") or [])
        order = schema.get("x-fal-order-properties") or list(props.keys())
        out: list[dict] = []
        for name in order:
            p = props.get(name)
            if not isinstance(p, dict):
                continue
            typ = p.get("type", "any")
            opts = p.get("enum") if isinstance(p.get("enum"), list) else []
            if opts:
                typ = f"enum {opts}"
            default = p.get("default", "")
            out.append({
                "name": name,
                "type": str(typ)[:200],
                "required": name in required,
                "default": "" if default == "" else str(default)[:120],
                "options": [str(o)[:80] for o in opts[:20]],
                "detail": str(p.get("description", ""))[:400],
            })
            if len(out) >= 40:
                break
        return out

    return rows(pick("Input")), rows(pick("Output")), meta


_GENERIC_EXPECTS = {
    "outpaint": (
        "This pipeline sends {video_url, prompt, aspect_ratio: '1:1'} and expects a "
        "video URL back. If the live schema above has no video_url input, the model "
        "almost certainly cannot run in this slot."
    ),
    "upscale": (
        "This pipeline sends {video_url, ...tuning} and expects a video URL back. "
        "If the live schema above has no video_url input, the model almost certainly "
        "cannot run in this slot."
    ),
    "image_upscale": (
        "This pipeline sends {image_url} and expects an image URL back. If the live "
        "schema above has no image_url input, the model almost certainly cannot run "
        "in this slot."
    ),
    "image_outpaint": (
        "This pipeline sends {image_url, top, bottom, left, right, prompt} and expects "
        "an image URL back. If the live schema above has no image_url input, the model "
        "almost certainly cannot run in this slot."
    ),
}


def _fetch_model_info(model_id: str, kind: str) -> dict:
    model = _models.normalize_model_id(model_id)
    display_fallback = _models.short_name(model)
    payload: dict = {
        "model": model,
        "found": False,
        "display_name": display_fallback,
        "category": "",
        "description": "",
        "pricing": "",
        "playground_url": f"https://fal.ai/models/{model}" if model else "",
        "documentation_url": "",
        "about": "",
        "inputs": [],
        "outputs": [],
        "compatibility": {
            "has_video_url": False,
            "has_image_url": False,
            "has_prompt": False,
            "note": _GENERIC_EXPECTS.get(kind, _GENERIC_EXPECTS["upscale"]),
        },
        "error": "",
    }
    if not model or "/" not in model:
        payload["error"] = "Not a fal.ai model id (expected owner/name[/variant])."
        return payload

    errors: list[str] = []

    # 1. Structured input/output schema from the queue OpenAPI (reliable).
    try:
        spec = json.loads(_http_get_text(
            "https://fal.ai/api/openapi/queue/openapi.json?endpoint_id="
            + urllib.parse.quote(model, safe="")
        ))
        inputs, outputs, meta = _openapi_io(spec)
        payload["inputs"] = inputs
        payload["outputs"] = outputs
        if meta.get("category"):
            payload["category"] = str(meta["category"])
        if meta.get("playgroundUrl"):
            payload["playground_url"] = str(meta["playgroundUrl"])
        if meta.get("documentationUrl"):
            payload["documentation_url"] = str(meta["documentationUrl"])
        if meta.get("about"):
            payload["about"] = str(meta["about"])[:2000]
    except Exception as ex:  # offline / unknown endpoint / schema-less model
        errors.append(f"schema: {ex}")

    # 2. Title/description/pricing prose from llms.txt.
    try:
        md = _http_get_text(f"https://fal.ai/models/{model}/llms.txt")
        if _title(md):
            payload["display_name"] = _title(md)
        if _first_quote(md):
            payload["description"] = _first_quote(md)
        pricing = _section(md, "Pricing")
        if pricing:
            payload["pricing"] = pricing[:2000]
        # Fall back to llms.txt param lists when the OpenAPI had no schemas.
        if not payload["inputs"]:
            payload["inputs"] = _parse_llms_params(_section(md, "Input Schema"))
        if not payload["outputs"]:
            payload["outputs"] = _parse_llms_params(_section(md, "Output Schema"))
    except Exception as ex:
        errors.append(f"metadata: {ex}")

    names = {r["name"] for r in payload["inputs"]}
    payload["compatibility"]["has_video_url"] = "video_url" in names
    payload["compatibility"]["has_image_url"] = "image_url" in names
    payload["compatibility"]["has_prompt"] = "prompt" in names

    if payload["inputs"] or payload["pricing"] or payload["description"]:
        payload["found"] = True
    else:
        payload["error"] = "; ".join(errors)[:500] or "Model not found on fal.ai."
    return payload


@router.get("/model-info")
def get_model_info(
    model: str = Query(..., description="fal.ai model id, e.g. fal-ai/foo/bar"),
    kind: str = Query("upscale", description="Pipeline slot: outpaint|upscale|image_upscale|image_outpaint"),
):
    """Pull live requirements, pricing and input/output schema for a model id."""
    norm = _models.normalize_model_id(model)
    key = f"{norm.lower()}|{kind}"
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and (now - hit[0]) < _CACHE_TTL_S:
            cached = dict(hit[1])
            cached["from_cache"] = True
            return cached
    payload = _fetch_model_info(norm, kind)
    payload["fetched_at"] = time.time()
    payload["from_cache"] = False
    with _cache_lock:
        _cache[key] = (time.time(), payload)
    return payload
