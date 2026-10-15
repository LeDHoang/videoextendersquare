"""Runtime feature flags shared by API and client configuration."""

from __future__ import annotations

import os


_FALSE_VALUES = {"0", "false", "no", "off"}


def feature_enabled(name: str, *, default: bool = True) -> bool:
    """Read a boolean environment flag without caching test/runtime changes."""
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().casefold() not in _FALSE_VALUES


def reel_pack_features() -> dict[str, bool]:
    return {
        "creation": feature_enabled("SX_REEL_PACK_CREATION_ENABLED"),
        "discovery": feature_enabled("SX_REEL_PACK_DISCOVERY_ENABLED"),
        "immersive": feature_enabled("SX_REEL_PACK_IMMERSIVE_ENABLED"),
    }
