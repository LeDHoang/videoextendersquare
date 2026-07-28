"""Video view — the guided 3-step flow, with engine gating and preview proxy."""

import streamlit as st

from ui import components as C
from ui import health as H
from ui import media as M
from ui import runner as R
from ui import state as S

NS = S.VID


def _staged_upload():
    with st.container(key="sx-upload-zone-vid"):
        uploaded = st.file_uploader(
            "Drop video",
            type=sorted(M.VIDEO_EXTS),
            label_visibility="collapsed",
            key=S.wkey(NS, "file"),
        )

    if uploaded is None:
        if S.get(NS, "sig"):
            S.reset_from(NS, S.STEP_UPLOAD)
        return None

    sig = S.upload_sig(uploaded)
    if sig != S.get(NS, "sig"):
        S.reset_from(NS, S.STEP_UPLOAD)
        path = M.stage_video(uploaded)
        try:
            meta = M.video_meta(path)
        except Exception as ex:  # noqa: BLE001
            M.discard_staged(path)
            st.error(f"Could not read this video: {ex}")
            return None
        S.set_(NS, "sig", sig)
        S.set_(NS, "src_path", path)
        S.set_(NS, "meta", meta)
        S.advance(NS, S.STEP_CONFIGURE)
    return S.get(NS, "meta")


def render(ctx: dict) -> None:
    probes = ctx["probes"]
    blocked = H.blockers(probes, need_video=True)
    studio_ok = H.studio_available(probes)

    C.hero("Square Extender 4K", "VIDEO · 1:1 · 3840×3840 · OUTPAINT + UPSCALE")

    if blocked:
        C.blocking_banner(
            "ENVIRONMENT NOT READY",
            [f"{p.label}: {p.detail}. {p.fix}" for p in blocked],
        )

    # ---------------------------------------------------------------- STEP 1
    C.step_header(1, "Upload", active=True, note="MP4 · MOV · AVI · WEBM")
    meta = _staged_upload()

    if meta:
        t, b, l, r = meta["pad"]
        C.spec_row([
            ("SOURCE", f"{meta['w']}×{meta['h']}",
             f"{meta['orientation']} · {M.human_bytes(meta['bytes'])}"),
            ("DURATION", f"{meta['dur']:.2f}s", ""),
            ("TARGET", "3840×3840", "1:1 SQUARE"),
            ("PAD", f"L {l}  R {r}", f"T {t}  B {b}"),
        ])
        if meta["dur"] > M.DURATION_SOFT_LIMIT:
            C.accent_block(
                f"{meta['dur']:.1f}s EXCEEDS THE {M.DURATION_SOFT_LIMIT:.0f}s THRESHOLD",
                ["Cloud outpainting is billed per second and the video model "
                 "throttles long clips, so render time grows faster than "
                 "duration.",
                 "Clips under 5 seconds are recommended for iteration."],
                tone="warn",
            )
        st.video(S.get(NS, "src_path"))

    # ---------------------------------------------------------------- STEP 2
    live = S.step(NS) >= S.STEP_CONFIGURE
    C.step_header(2, "Configure", active=live)

    if not live:
        C.empty_state("AWAITING SOURCE",
                      "Drop a video above to unlock the pipeline settings.")
    else:
        C.eyebrow("MODE")
        mode = st.segmented_control(
            "Mode", ["OUTPAINT + UPSCALE", "UPSCALE ONLY"],
            default="OUTPAINT + UPSCALE", label_visibility="collapsed",
            key=S.wkey(NS, "mode"),
        ) or "OUTPAINT + UPSCALE"
        upscale_only = mode == "UPSCALE ONLY"

        prompt = S.get(NS, "prompt_cache") or (
            "Seamlessly extend the background environment, high details, "
            "matching texture and lighting."
        )
        if not upscale_only:
            C.eyebrow("PROMPT")
            prompt = st.text_area(
                "Outpaint prompt", value=prompt, label_visibility="collapsed",
                key=S.wkey(NS, "prompt"), height=100,
            )
            S.set_(NS, "prompt_cache", prompt)

        # Studio stays visible even when unavailable — it is the product's
        # differentiator, so hiding it teaches nothing. Instead: explain, and
        # block the render button.
        C.eyebrow("UPSCALE ENGINE")
        engine = st.segmented_control(
            "Engine", ["FAST", "STUDIO"], default="FAST",
            label_visibility="collapsed", key=S.wkey(NS, "engine"),
        ) or "FAST"
        studio_picked = engine == "STUDIO"

        if studio_picked and not studio_ok:
            missing = []
            if not probes["vapoursynth"].ok:
                missing.append("VapourSynth + vspipe")
            if not probes["znedi3"].ok:
                missing.append("the znedi3 plugin")
            C.accent_block(
                "STUDIO UNAVAILABLE",
                [f"This machine is missing {' and '.join(missing)}, so the "
                 "znedi3 neural upscale cannot run.",
                 "FAST uses Lanczos4 + CAS via FFmpeg and works now."],
                code=["pip install vapoursynth", "+ vsznedi3 plugin"],
            )

        cas_ok = probes["cas"].ok
        sharpening = 0.0
        if not studio_picked:
            C.eyebrow("SHARPEN (CAS)")
            sharpening = st.slider(
                "Sharpening", 0.0, 1.0, 0.5, 0.05,
                label_visibility="collapsed", disabled=not cas_ok,
                key=S.wkey(NS, "sharpen"),
            )
            if not cas_ok:
                C.gated_reason("CAS FILTER UNAVAILABLE — SHARPENING SKIPPED")
                sharpening = 0.0

        missing_key = (not upscale_only) and not ctx["fal"].ok
        studio_blocked = studio_picked and not studio_ok
        disabled = (bool(blocked) or missing_key or studio_blocked
                    or S.get(NS, "running", False))

        st.markdown("")
        go = st.button("▶  RENDER 4K SQUARE", type="primary", disabled=disabled,
                       key=S.wkey(NS, "go"), width="stretch")

        if blocked:
            C.gated_reason(f"{blocked[0].label} UNAVAILABLE — SEE SYSTEM")
        elif studio_blocked:
            C.gated_reason("STUDIO ENGINE NOT INSTALLED — SWITCH TO FAST")
        elif missing_key:
            C.gated_reason("FAL KEY REQUIRED FOR OUTPAINTING — OR USE UPSCALE ONLY")

        if go:
            from pipeline.video_worker import process_video

            S.set_(NS, "running", True)
            out, err = R.run_pipeline(NS, "video", process_video, {
                "video_path": S.get(NS, "src_path"),
                "prompt": None if upscale_only else prompt,
                "fal_key": None if upscale_only else ctx["fal_key"],
                "outpaint_model": None if upscale_only
                                  else ctx["models"]["outpaint_vid"],
                "upscale_model": None if upscale_only
                                 else ctx["models"]["upscale_vid"],
                "upscale_only": upscale_only,
                "sharpening": sharpening,
                "upscale_engine": "studio" if studio_picked else "fast",
            })
            S.set_(NS, "running", False)

            if err:
                S.set_(NS, "error", err)
                S.clear(NS, "result")
            else:
                _url, path = out
                rec = M.persist_result(path, "video", {
                    "mode": mode, "engine": engine, "sharpening": sharpening,
                })
                # The master is HEVC, which does not decode in the browser.
                # Transcode a small H.264 proxy for the player only.
                if probes["libx264"].ok:
                    with st.spinner("Building preview proxy…"):
                        rec["preview"] = M.make_web_preview(rec["path"])
                S.set_(NS, "result", rec)
                S.clear(NS, "error")
                S.advance(NS, S.STEP_RESULT)
            st.rerun()

    # ---------------------------------------------------------------- STEP 3
    result = S.get(NS, "result")
    err = S.get(NS, "error")
    C.step_header(3, "Result", active=bool(result))

    if err:
        headline, detail = err
        C.accent_block(headline, [detail])
        _render_log()
        return

    if not result:
        C.empty_state("NO RENDER YET",
                      "Configure the pipeline and render to produce a "
                      "3840×3840 master.")
        return

    dur = (S.get(NS, "meta") or {}).get("dur")
    C.result_header(
        "03 / RESULT",
        f"3840×3840 · HEVC MP4 · {M.human_bytes(result['bytes'])}"
        + (f" · {dur:.2f}s" if dur else ""),
    )

    if result.get("preview"):
        st.video(result["preview"])
        C.eyebrow("PREVIEW IS AN H.264 PROXY · DOWNLOAD FOR THE HEVC MASTER")
    else:
        C.accent_block(
            "NO BROWSER PREVIEW",
            ["The master is HEVC, which most browsers cannot decode, and an "
             "H.264 proxy could not be built. Download the file to view it."],
        )

    d1, d2, d3 = st.columns([2, 2, 1])
    with d1:
        st.download_button(
            "↓  DOWNLOAD MASTER (HEVC)",
            data=M.download_bytes(result["path"]),
            file_name="extended_4k_video.mp4", mime="video/mp4",
            type="primary", width="stretch", key=S.wkey(NS, "dl"),
        )
    with d2:
        if result.get("preview"):
            st.download_button(
                "↓  PROXY (H.264)",
                data=M.download_bytes(result["preview"]),
                file_name="extended_4k_preview.mp4", mime="video/mp4",
                width="stretch", key=S.wkey(NS, "dlp"),
            )
    with d3:
        if st.button("↻  RUN AGAIN", key=S.wkey(NS, "again"), width="stretch"):
            S.reset_from(NS, S.STEP_CONFIGURE)
            st.rerun()

    C.mono(result["path"])
    _render_log()


def _render_log() -> None:
    log = S.get(NS, "log")
    if not log:
        return
    elapsed = S.get(NS, "elapsed", "")
    with st.expander(f"▸ RENDER LOG{f' · {elapsed}' if elapsed else ''}"):
        st.code("\n".join(log), language=None)
