"""Image view — the guided 3-step flow: UPLOAD → CONFIGURE → RESULT."""

import streamlit as st

from ui import components as C
from ui import health as H
from ui import media as M
from ui import runner as R
from ui import state as S

NS = S.IMG


def _staged_upload():
    """Render the uploader and keep session_state in sync with what's staged."""
    with st.container(key="sx-upload-zone"):
        uploaded = st.file_uploader(
            "Drop image",
            type=sorted(M.IMAGE_EXTS),
            label_visibility="collapsed",
            key=S.wkey(NS, "file"),
        )

    if uploaded is None:
        if S.get(NS, "sig"):
            S.reset_from(NS, S.STEP_UPLOAD)
        return None

    sig = S.upload_sig(uploaded)
    if sig != S.get(NS, "sig"):
        # New file: invalidate everything downstream in one place.
        S.reset_from(NS, S.STEP_UPLOAD)
        data = M.read_upload_bytes(uploaded)
        try:
            meta = M.image_meta(data)
        except Exception as ex:  # noqa: BLE001
            st.error(f"Could not read this image: {ex}")
            return None
        S.set_(NS, "sig", sig)
        S.set_(NS, "bytes", data)
        S.set_(NS, "meta", meta)
        S.advance(NS, S.STEP_CONFIGURE)
    return S.get(NS, "meta")


def render(ctx: dict) -> None:
    probes = ctx["probes"]
    blocked = H.blockers(probes, need_video=False)

    C.hero("Square Extender 4K", "1:1 · 3840×3840 · OUTPAINT + UPSCALE")

    if blocked:
        C.blocking_banner(
            "ENVIRONMENT NOT READY",
            [f"{p.label}: {p.detail}. {p.fix}" for p in blocked],
        )

    # ---------------------------------------------------------------- STEP 1
    meta = None
    C.step_header(1, "Upload", active=True,
                  note="PNG · JPG · WEBP")
    meta = _staged_upload()

    if meta:
        t, b, l, r = meta["pad"]
        C.spec_row([
            ("SOURCE", f"{meta['w']}×{meta['h']}",
             f"{meta['orientation']} · {M.human_bytes(meta['bytes'])}"),
            ("TARGET", "3840×3840", "1:1 SQUARE"),
            ("PAD", f"L {l}  R {r}", f"T {t}  B {b}"),
        ])
        st.image(S.get(NS, "bytes"), width=260)

    # ---------------------------------------------------------------- STEP 2
    live = S.step(NS) >= S.STEP_CONFIGURE
    C.step_header(2, "Configure", active=live)

    if not live:
        C.empty_state("AWAITING SOURCE",
                      "Drop an image above to unlock the pipeline settings.")
        mode = None
    else:
        C.eyebrow("MODE")
        mode = st.segmented_control(
            "Mode",
            ["OUTPAINT + UPSCALE", "UPSCALE ONLY"],
            default="OUTPAINT + UPSCALE",
            label_visibility="collapsed",
            key=S.wkey(NS, "mode"),
        ) or "OUTPAINT + UPSCALE"
        upscale_only = mode == "UPSCALE ONLY"

        prompt = S.get(NS, "prompt_cache") or (
            "Seamlessly extend the background environment, high details, "
            "matching texture and lighting."
        )
        if not upscale_only:
            # Rendered only when it applies — a greyed-out textarea full of
            # uneditable text is noise. The value persists either way.
            C.eyebrow("PROMPT")
            prompt = st.text_area(
                "Outpaint prompt", value=prompt, label_visibility="collapsed",
                key=S.wkey(NS, "prompt"), height=100,
            )
            S.set_(NS, "prompt_cache", prompt)

        cas_ok = probes["cas"].ok
        C.eyebrow("SHARPEN (CAS)")
        sharpening = st.slider(
            "Sharpening", 0.0, 1.0, 0.5, 0.05,
            label_visibility="collapsed",
            disabled=not cas_ok,
            key=S.wkey(NS, "sharpen"),
        )
        if not cas_ok:
            C.gated_reason("CAS FILTER UNAVAILABLE — SHARPENING SKIPPED")
            sharpening = 0.0

        needs_key = not upscale_only
        missing_key = needs_key and not ctx["fal"].ok
        disabled = bool(blocked) or missing_key or S.get(NS, "running", False)

        st.markdown("")
        go = st.button("▶  RENDER 4K SQUARE", type="primary",
                       disabled=disabled, key=S.wkey(NS, "go"),
                       width="stretch")

        if blocked:
            C.gated_reason(f"{blocked[0].label} UNAVAILABLE — SEE SYSTEM")
        elif missing_key:
            C.gated_reason("FAL KEY REQUIRED FOR OUTPAINTING — OR USE UPSCALE ONLY")

        if go:
            from pipeline.image_worker import process_image

            S.set_(NS, "running", True)
            out, err = R.run_pipeline(NS, "image", process_image, {
                "image_source": S.get(NS, "bytes"),
                "prompt": None if upscale_only else prompt,
                "fal_key": None if upscale_only else ctx["fal_key"],
                "upscale_only": upscale_only,
                "sharpening": sharpening,
            })
            S.set_(NS, "running", False)

            if err:
                S.set_(NS, "error", err)
                S.clear(NS, "result")
            else:
                _url, path = out
                S.set_(NS, "result", M.persist_result(path, "image", {
                    "mode": mode, "sharpening": sharpening,
                }))
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

    C.result_header("03 / RESULT",
                    f"3840×3840 · PNG · {M.human_bytes(result['bytes'])}")

    view = st.segmented_control(
        "View", ["AFTER", "SIDE BY SIDE"], default="AFTER",
        label_visibility="collapsed", key=S.wkey(NS, "resultview"),
    ) or "AFTER"

    if view == "SIDE BY SIDE" and S.get(NS, "bytes"):
        a, b = st.columns(2)
        with a:
            C.eyebrow("SOURCE")
            st.image(S.get(NS, "bytes"), width="stretch")
        with b:
            C.eyebrow("4K SQUARE")
            st.image(result["path"], width="stretch")
    else:
        st.image(result["path"], width="stretch")

    d1, d2 = st.columns([2, 1])
    with d1:
        st.download_button(
            "↓  DOWNLOAD PNG",
            data=M.download_bytes(result["path"]),
            file_name="delivery_4k_square.png",
            mime="image/png",
            type="primary",
            width="stretch",
            key=S.wkey(NS, "dl"),
        )
    with d2:
        if st.button("↻  RUN AGAIN", key=S.wkey(NS, "again"), width="stretch"):
            S.reset_from(NS, S.STEP_CONFIGURE)
            st.rerun()

    C.mono(result["path"])
    _render_log()


def _render_log() -> None:
    """The st.status element does not survive the next rerun, so rebuild the
    terminal state from session_state or all diagnostics vanish on any click."""
    log = S.get(NS, "log")
    if not log:
        return
    elapsed = S.get(NS, "elapsed", "")
    with st.expander(f"▸ RENDER LOG{f' · {elapsed}' if elapsed else ''}"):
        st.code("\n".join(log), language=None)
