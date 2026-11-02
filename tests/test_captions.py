"""Auto captions: WebVTT from the optional speech model, skipped when it cannot run."""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from server import media as SM
from server.routers import reels

needs_ffmpeg = pytest.mark.skipif(
    not (shutil.which("ffmpeg") and shutil.which("ffprobe")),
    reason="ffmpeg/ffprobe are required to build sample media",
)


class FakeSpeech:
    def __init__(self, segments=()):
        self.segments = [SimpleNamespace(start=start, end=end, text=text, words=None) for start, end, text in segments]
        self.calls = 0

    def transcribe(self, src, **kwargs):
        self.calls += 1
        return iter(self.segments), SimpleNamespace(language="en")


@pytest.fixture
def fresh_model_cache(monkeypatch):
    SM._load_caption_model.cache_clear()
    monkeypatch.setattr(SM, "_caption_retry_at", 0.0)
    yield
    SM._load_caption_model.cache_clear()


def _clip(path: Path, audio: bool) -> Path:
    inputs = ["-f", "lavfi", "-i", "testsrc=size=64x64:rate=10:duration=1"]
    if audio:
        inputs += ["-f", "lavfi", "-i", "sine=frequency=440:duration=1"]
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", *inputs, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-shortest", str(path)],
        check=True,
    )
    return path


def test_webvtt_times_and_escapes_each_cue():
    text = SM.webvtt([(0.5, 2.25, "Hi <b> & -->"), (3661.0049, 3662, "x")])
    assert text == (
        "WEBVTT\n\n"
        "00:00:00.500 --> 00:00:02.250\nHi &lt;b&gt; &amp; --&gt;\n\n"
        "01:01:01.005 --> 01:01:02.000\nx\n"
    )


def test_long_segments_split_at_word_timings_into_two_line_cues():
    words = [SimpleNamespace(start=i * 0.5, end=i * 0.5 + 0.4, word=f" word{i:02d}") for i in range(30)]
    long = SimpleNamespace(start=0.0, end=15.0, text=" ".join(w.word.strip() for w in words), words=words)
    untimed = SimpleNamespace(start=20.0, end=21.0, text=" No word timings ", words=None)
    silent = SimpleNamespace(start=22.0, end=23.0, text=" ", words=[SimpleNamespace(start=22.0, end=22.5, word=" ")])
    cues = SM.caption_cues([long, untimed, silent])
    # 6-character words: 12 fit in 84 characters (12 * 6 + 11 spaces = 83).
    assert [(start, end, len(text.split())) for start, end, text in cues] == [
        (0.0, 5.9, 12),
        (6.0, 11.9, 12),
        (12.0, 14.9, 6),
        (20.0, 21.0, 3),
    ]
    assert all(len(text) <= SM.CAPTION_MAX_CHARS for _start, _end, text in cues)
    assert cues[0][2].startswith("word00 word01") and cues[-1][2] == "No word timings"


def test_words_keep_whispers_own_spacing():
    def segment(*words):
        timed = [SimpleNamespace(start=i * 0.5, end=i * 0.5 + 0.4, word=word) for i, word in enumerate(words)]
        return SimpleNamespace(start=0.0, end=len(words) * 0.5, text="".join(words), words=timed)

    cues = SM.caption_cues([segment("สวัสดี", "ครับ"), segment("曼谷", "很", "热"), segment(" Hello", " there.")])
    assert [text for _start, _end, text in cues] == ["สวัสดีครับ", "曼谷很热", "Hello there."]


def test_the_captions_sit_next_to_the_original():
    assert SM.captions_path("output/uploads/clip.mp4") == Path("output/uploads/clip.vtt")
    assert SM.captions_path("output/uploads/clip.mp4") in SM.derived_files(Path("output/uploads/clip.mp4"))


@needs_ffmpeg
def test_has_audio_reads_the_audio_stream(tmp_path):
    assert SM.has_audio(str(_clip(tmp_path / "loud.mp4", audio=True))) is True
    assert SM.has_audio(str(_clip(tmp_path / "quiet.mp4", audio=False))) is False
    assert SM.has_audio(str(tmp_path / "missing.mp4")) is False


def test_make_captions_writes_webvtt(tmp_path, monkeypatch):
    src = tmp_path / "clip.mp4"
    src.write_bytes(b"video")
    monkeypatch.setattr(SM, "_caption_model", lambda: FakeSpeech([(0, 1, " One "), (1, 2, "Two")]))
    monkeypatch.setattr(SM, "has_audio", lambda path: True)
    assert SM.make_captions(str(src)) == str(tmp_path / "clip.vtt")
    assert (tmp_path / "clip.vtt").read_text(encoding="utf-8") == (
        "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nOne\n\n00:00:01.000 --> 00:00:02.000\nTwo\n"
    )
    assert not list(tmp_path.glob(".*.part"))


@pytest.mark.parametrize(
    "model, audio",
    [
        (None, True),  # the speech model cannot run on this host
        (FakeSpeech([(0, 1, "unheard")]), False),  # nothing to listen to
        (FakeSpeech([(0, 1, "  "), (1, 2, "")]), True),  # audio, but no speech
    ],
)
def test_make_captions_writes_nothing_without_speech(tmp_path, monkeypatch, model, audio):
    src = tmp_path / "clip.mp4"
    src.write_bytes(b"video")
    monkeypatch.setattr(SM, "_caption_model", lambda: model)
    monkeypatch.setattr(SM, "has_audio", lambda path: audio)
    assert SM.make_captions(str(src)) is None
    assert sorted(path.name for path in tmp_path.iterdir()) == ["clip.mp4"]


def test_make_captions_reuses_fresh_captions_and_redoes_stale_ones(tmp_path, monkeypatch):
    src = tmp_path / "clip.mp4"
    src.write_bytes(b"video")
    vtt = tmp_path / "clip.vtt"
    vtt.write_text("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nEarlier\n", encoding="utf-8")
    speech = FakeSpeech([(0, 1, "Again")])
    monkeypatch.setattr(SM, "_caption_model", lambda: speech)
    monkeypatch.setattr(SM, "has_audio", lambda path: True)
    assert SM.make_captions(str(src)) == str(vtt)
    assert speech.calls == 0 and "Earlier" in vtt.read_text(encoding="utf-8")

    # The original was replaced after its captions were made.
    os.utime(vtt, (1, 1))
    assert SM.make_captions(str(src)) == str(vtt)
    assert speech.calls == 1 and "Again" in vtt.read_text(encoding="utf-8")


def test_the_model_is_off_when_faster_whisper_is_not_installed(monkeypatch, fresh_model_cache, caplog):
    monkeypatch.setitem(sys.modules, "faster_whisper", None)
    with caplog.at_level(logging.INFO, logger="server.media"):
        assert SM._caption_model() is None
    assert "faster-whisper is not installed" in caplog.text


def test_the_model_is_off_when_its_weights_cannot_load(monkeypatch, fresh_model_cache, caplog):
    def offline(*args, **kwargs):
        raise OSError("huggingface.co is unreachable")

    monkeypatch.setitem(sys.modules, "faster_whisper", SimpleNamespace(WhisperModel=offline))
    with caplog.at_level(logging.ERROR, logger="server.media"):
        assert SM._caption_model() is None
    assert "the base speech model could not load" in caplog.text


def test_the_model_loads_once_on_the_cpu(monkeypatch, fresh_model_cache):
    loads = []

    def whisper(*args, **kwargs):
        loads.append((args, kwargs))
        return SimpleNamespace(name="whisper")

    monkeypatch.setitem(sys.modules, "faster_whisper", SimpleNamespace(WhisperModel=whisper))
    assert SM._caption_model() is SM._caption_model()
    assert loads == [(("base",), {"device": "cpu", "compute_type": "int8"})]


def test_a_failed_load_is_retried_after_a_cool_down(monkeypatch, fresh_model_cache):
    now = [1000.0]
    online = [False]
    loads = []

    def whisper(*args, **kwargs):
        loads.append(now[0])
        if not online[0]:
            raise OSError("huggingface.co is unreachable")
        return SimpleNamespace(name="whisper")

    monkeypatch.setattr(SM.time, "monotonic", lambda: now[0])
    monkeypatch.setitem(sys.modules, "faster_whisper", SimpleNamespace(WhisperModel=whisper))
    assert SM._caption_model() is None
    online[0] = True
    # Inside the cool-down every publish skips captions without trying again.
    now[0] += SM.CAPTIONS_RETRY_S - 1
    assert SM._caption_model() is None
    assert loads == [1000.0]
    # After it, the next publish loads the model, and keeps it.
    now[0] += 1
    model = SM._caption_model()
    assert model is not None and SM._caption_model() is model
    assert len(loads) == 2


@needs_ffmpeg
def test_the_feed_links_fresh_captions_of_videos_only(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    folder = tmp_path / "output" / "clips"
    folder.mkdir(parents=True)
    _clip(folder / "talk.mp4", audio=True)
    _clip(folder / "stale.mp4", audio=True)
    _clip(folder / "silent.mp4", audio=False)
    (folder / "talk.vtt").write_text("WEBVTT\n", encoding="utf-8")
    (folder / "stale.vtt").write_text("WEBVTT\n", encoding="utf-8")
    os.utime(folder / "stale.vtt", (1, 1))
    (folder / "still.png").write_bytes(b"png")
    (folder / "still.vtt").write_text("WEBVTT\n", encoding="utf-8")
    monkeypatch.setattr(reels, "reel_records", lambda paths, **kwargs: {})

    payload = reels._build_payload(SM.scan_output_media("output"), "h264")
    captions = {item["filename"]: item["captions_url"] for item in payload}
    assert captions == {
        "talk.mp4": "/media/clips/talk.vtt",
        "stale.mp4": None,
        "silent.mp4": None,
        "still.png": None,
    }

    # A post's media record answers instead of the disk.
    rel = "clips/silent.mp4"
    monkeypatch.setattr(
        reels, "reel_records", lambda paths, **kwargs: {rel: {"media_files": {rel: {"bytes": 1}, "clips/silent.vtt": {"bytes": 1}}}}
    )
    payload = reels._build_payload([item for item in SM.scan_output_media("output") if item["rel_path"] == rel], "h264")
    assert [item["captions_url"] for item in payload] == ["/media/clips/silent.vtt"]
