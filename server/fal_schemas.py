"""Live fal input schemas for the credit catalog in core/models.py.

On the same timer as server/fal_prices.py, the writer reads each credit-priced
stock model's public OpenAPI schema from fal (no key needed), keeps a snapshot
of its input options in app_settings["fal_schemas"] and applies it with
core.models.apply_fal_schemas():

- an option the catalog offers that fal no longer accepts is removed at once
  (quotes reject it and the upload pages stop showing it), and alerts;
- frame limits follow fal's;
- any other change to fal's options (a new resolution, a new tier, a field
  added or removed) only alerts, since a new option has no price here yet.

The first sync stores the snapshot without alerting. When fal cannot be
reached, the last stored snapshot stays in force and prices are not touched.
"""

from __future__ import annotations

import hashlib
import json
import logging
import urllib.parse
import urllib.request

import sentry_sdk
from sqlalchemy.orm import Session

from core import models
from server.social.models import AppSetting, utcnow

logger = logging.getLogger("server.fal_schemas")

SCHEMA_URL = "https://fal.ai/api/openapi/queue/openapi.json"
SETTING_KEY = "fal_schemas"
_TIMEOUT_S = 20


def _alert(fingerprint: list[str], message: str) -> None:
    with sentry_sdk.new_scope() as scope:
        scope.fingerprint = ["fal-schema", *fingerprint]
        logger.error("ALERT fal_schema: %s", message, extra={"alert": "fal_schema"})


def fetch_schema(endpoint_id: str) -> dict:
    """fal's OpenAPI document for one endpoint."""
    request = urllib.request.Request(
        f"{SCHEMA_URL}?{urllib.parse.urlencode({'endpoint_id': endpoint_id})}",
        headers={"Accept": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=_TIMEOUT_S) as response:
        return json.load(response)


def _resolve(document: dict, node: dict) -> dict:
    """The node with $ref, allOf and anyOf folded into one dict (enum and bounds only)."""
    schemas = (document.get("components") or {}).get("schemas") or {}
    while "$ref" in node:
        node = {**schemas[node["$ref"].rsplit("/", 1)[-1]], **{k: v for k, v in node.items() if k != "$ref"}}
    out = {k: v for k, v in node.items() if k not in ("allOf", "anyOf")}
    for part in [*(node.get("allOf") or []), *(node.get("anyOf") or [])]:
        part = _resolve(document, part)
        if "enum" in part:
            out["enum"] = [*(out.get("enum") or []), *part["enum"]]
        for key in ("minimum", "maximum", "maxItems"):
            if key in part and key not in out:
                out[key] = part[key]
    return out


def input_snapshot(document: dict) -> dict:
    """The options of an endpoint's input, order-free: field names, enums, bounds, required."""
    # The submit path is the one POST without a {request_id} in it.
    operation = next(
        path["post"] for name, path in document["paths"].items() if "post" in path and "{" not in name
    )
    schema = _resolve(document, operation["requestBody"]["content"]["application/json"]["schema"])
    fields = {}
    for name, node in (schema.get("properties") or {}).items():
        node = _resolve(document, node)
        field = {}
        if "enum" in node:
            field["enum"] = sorted({str(value) for value in node["enum"] if value is not None})
        for source, key in (("minimum", "minimum"), ("maximum", "maximum"), ("maxItems", "max_items")):
            if isinstance(node.get(source), (int, float)) and not isinstance(node.get(source), bool):
                field[key] = node[source]
        fields[name] = field
    return {"required": sorted(schema.get("required") or []), "fields": fields}


def describe_changes(old: dict, new: dict) -> list[str]:
    """What changed between two snapshots, one line each."""
    lines = []
    old_fields, new_fields = old.get("fields") or {}, new.get("fields") or {}
    for name in sorted(new_fields.keys() - old_fields.keys()):
        lines.append(f"new field {name}")
    for name in sorted(old_fields.keys() - new_fields.keys()):
        lines.append(f"field {name} removed")
    for name in sorted(old_fields.keys() & new_fields.keys()):
        before, after = old_fields[name], new_fields[name]
        added = sorted(set(after.get("enum") or []) - set(before.get("enum") or []))
        removed = sorted(set(before.get("enum") or []) - set(after.get("enum") or []))
        if added:
            lines.append(f"{name} added {', '.join(added)}")
        if removed:
            lines.append(f"{name} dropped {', '.join(removed)}")
        for key in ("minimum", "maximum", "max_items"):
            if before.get(key) != after.get(key):
                lines.append(f"{name} {key} {before.get(key)} -> {after.get(key)}")
    if old.get("required") != new.get("required"):
        lines.append(f"required fields now {', '.join(new.get('required') or []) or 'none'}")
    return lines


def _digest(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()[:12]


def _stored(db: Session) -> dict[str, dict]:
    row = db.get(AppSetting, SETTING_KEY)
    return dict(row.value) if row is not None and isinstance(row.value, dict) else {}


def load(db: Session) -> None:
    """Limit the catalog to the last stored schemas (writer startup)."""
    models.apply_fal_schemas(_stored(db))


def sync(db: Session) -> list[str]:
    """Fetch, store and apply fal's input schemas; returns the model ids that changed."""
    entries = models.synced_entries()
    try:
        snapshots = {
            entry["model"]: input_snapshot(fetch_schema(entry["model"]))
            for entry in entries
        }
    except Exception as exc:
        # The last stored schemas stay in force. One Sentry issue for all such failures.
        _alert(["sync-failed"], f"Could not read fal input schemas; keeping the last ones: {exc}")
        return []
    previous = _stored(db)
    changed = []
    for entry in entries:
        model_id = entry["model"]
        old, new = previous.get(model_id), snapshots[model_id]
        if old is not None and old != new:
            changed.append(model_id)
            _alert(
                [model_id, _digest(new)],
                f"{model_id} changed its options on fal: {'; '.join(describe_changes(old, new))}. "
                "New options are not offered until they are priced in core/models.py.",
            )
        gone = models.unsupported_options(entry, new)
        if gone and gone != models.unsupported_options(entry, old):
            _alert(
                [model_id, "unsupported", _digest(gone)],
                f"{model_id} no longer accepts "
                f"{'; '.join(f'{name} {", ".join(values)}' for name, values in sorted(gone.items()))}; "
                "those options are no longer offered.",
            )
    row = db.get(AppSetting, SETTING_KEY)
    if row is None:
        db.add(AppSetting(key=SETTING_KEY, value=snapshots))
    else:
        row.value = snapshots
        row.updated_at = utcnow()
    db.commit()
    models.apply_fal_schemas(snapshots)
    return changed
