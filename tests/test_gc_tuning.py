"""The app freezes its startup heap so full collections stop walking it (server/app.py)."""
import gc
import inspect

from server import app as app_module


def test_startup_heap_is_frozen_and_generation_0_collects_less_often():
    threshold = gc.get_threshold()
    try:
        app_module._freeze_startup_heap()
        assert gc.get_freeze_count() > 10_000
        assert gc.get_threshold()[0] == 10_000
    finally:
        gc.unfreeze()
        gc.set_threshold(*threshold)


def test_lifespan_freezes_at_startup_and_unfreezes_at_shutdown():
    source = inspect.getsource(app_module.lifespan)
    assert source.index("_freeze_startup_heap()") < source.index("yield") < source.index("gc.unfreeze()")
