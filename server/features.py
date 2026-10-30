"""Runtime feature flags shared by API and client configuration."""

from __future__ import annotations

import os
from functools import lru_cache
from importlib.util import find_spec


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


@lru_cache(maxsize=1)
def stereo_convert_installed() -> bool:
    """The depth model's packages (requirements-3d.txt) are installed.

    find_spec checks without importing torch; probed once per process."""
    return all(find_spec(name) for name in ("torch", "torchvision", "cv2", "einops", "easydict", "tqdm"))


def stereo_convert_enabled() -> bool:
    """MAKE 3D is switched on (off by default) and can run on this host."""
    return feature_enabled("SX_STEREO_CONVERT_ENABLED", default=False) and stereo_convert_installed()
