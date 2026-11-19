"""Live fal prices for the credit catalog in core/models.py.

Every SX_FAL_PRICE_SYNC_S (default one hour), the writer asks fal's pricing API
for each credit-priced stock model, using the platform FAL_KEY, and stores the
answer in app_settings["fal_prices"]. core.models.apply_synced_prices() then
prices quotes, /api/config and the estimates from it. A change applies at once
and is logged as an ALERT error (one Sentry issue per change, so each one
emails). Quotes already issued keep the price they were quoted at.

A model whose unit is not the one the catalog expects, whose price is not a
positive USD amount, or that fal no longer lists gets credits turned off until
a later sync is clean. When the API cannot be reached, the last stored prices
stay in force.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

import sentry_sdk
from sqlalchemy.orm import Session

from core import models
from server.social.models import AppSetting, utcnow

logger = logging.getLogger("server.fal_prices")

PRICING_URL = "https://api.fal.ai/v1/models/pricing"
SETTING_KEY = "fal_prices"
_TIMEOUT_S = 20


def _alert(fingerprint: list[str], message: str) -> None:
    with sentry_sdk.new_scope() as scope:
        scope.fingerprint = ["fal-price", *fingerprint]
        logger.error("ALERT fal_price: %s", message, extra={"alert": "fal_price"})


def fetch_prices(key: str, endpoint_ids: list[str]) -> dict[str, dict]:
    """fal's price rows keyed by endpoint id; ids fal does not know are absent."""
    rows: dict[str, dict] = {}
    cursor = None
    while True:
        query = [("endpoint_id", endpoint_id) for endpoint_id in endpoint_ids]
        if cursor:
            query.append(("cursor", cursor))
        request = urllib.request.Request(
            f"{PRICING_URL}?{urllib.parse.urlencode(query)}",
            headers={"Authorization": f"Key {key}", "Accept": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=_TIMEOUT_S) as response:
            payload = json.load(response)
        for row in payload.get("prices") or []:
            rows[str(row.get("endpoint_id"))] = row
        cursor = payload.get("next_cursor")
        if not (payload.get("has_more") and cursor):
            return rows


def evaluate(fetched: dict[str, dict], synced_at: str) -> dict[str, dict]:
    """One sync record per credit-priced entry, with its status."""
    records = {}
    for entry in models.synced_entries():
        model_id = entry["model"]
        row = fetched.get(model_id)
        if row is None:
            records[model_id] = {"status": "missing", "synced_at": synced_at}
            continue
        unit = str(row.get("unit") or "")
        currency = str(row.get("currency") or "")
        try:
            unit_price = Decimal(str(row.get("unit_price")))
        except InvalidOperation:
            unit_price = Decimal(0)
        if unit != entry["fal_unit"]:
            status = "unit_mismatch"
        elif currency.upper() != "USD" or not unit_price.is_finite() or unit_price <= 0:
            status = "invalid_price"
        else:
            status = "ok"
        records[model_id] = {
            "status": status,
            "unit_price": str(row.get("unit_price")),
            "unit": unit,
            "currency": currency,
            "synced_at": synced_at,
        }
    return records


def _stored(db: Session) -> dict[str, dict]:
    row = db.get(AppSetting, SETTING_KEY)
    return dict(row.value) if row is not None and isinstance(row.value, dict) else {}


def load(db: Session) -> None:
    """Price the catalog from the last stored sync (writer startup)."""
    models.apply_synced_prices(_stored(db))


def _code_record(entry: dict) -> dict:
    return {"status": "ok", "unit_price": entry["fal_base_usd"], "unit": entry["fal_unit"]}


def _same(old: dict, new: dict) -> bool:
    if old.get("status") != new.get("status"):
        return False
    if new["status"] == "missing":
        return True
    try:
        same_price = Decimal(str(old.get("unit_price"))) == Decimal(str(new.get("unit_price")))
    except InvalidOperation:
        same_price = False
    return same_price and old.get("unit") == new.get("unit")


def _report(model_id: str, old: dict, new: dict) -> None:
    status = new["status"]
    if status == "ok":
        _alert(
            [model_id, "price", str(new["unit_price"]), new["unit"]],
            f"{model_id} now costs {new['unit_price']} USD per {new['unit']} "
            f"(was {old.get('unit_price')} per {old.get('unit')}); credit prices follow it.",
        )
    elif status == "missing":
        _alert([model_id, "missing"], f"{model_id} is no longer listed by fal; credits are off for it.")
    else:
        _alert(
            [model_id, status, str(new.get("unit_price")), str(new.get("unit"))],
            f"{model_id} is priced {new.get('unit_price')} {new.get('currency')} per {new.get('unit')} "
            f"({status}); credits are off for it until fal's price matches the catalog again.",
        )


def sync(db: Session) -> list[str]:
    """Fetch, store and apply fal's prices; returns the model ids that changed."""
    key = os.environ.get("FAL_KEY", "").strip()
    if not key:
        return []
    entries = models.synced_entries()
    try:
        fetched = fetch_prices(key, [entry["model"] for entry in entries])
    except Exception as exc:
        # The last stored prices stay in force. One Sentry issue for all such failures.
        _alert(["sync-failed"], f"Could not read fal prices; keeping the last ones: {exc}")
        return []
    previous = _stored(db)
    records = evaluate(fetched, datetime.now(timezone.utc).isoformat())
    changed = []
    for entry in entries:
        model_id = entry["model"]
        old = previous.get(model_id) or _code_record(entry)
        if not _same(old, records[model_id]):
            changed.append(model_id)
            _report(model_id, old, records[model_id])
    row = db.get(AppSetting, SETTING_KEY)
    if row is None:
        db.add(AppSetting(key=SETTING_KEY, value=records))
    else:
        row.value = records
        row.updated_at = utcnow()
    db.commit()
    models.apply_synced_prices(records)
    return changed
