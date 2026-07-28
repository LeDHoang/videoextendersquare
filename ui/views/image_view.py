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
            "Drop images",
            type=sorted(M.IMAGE_EXTS),
            accept_multiple_files=True,
            label_visibility="collapsed",
            key=S.wkey(NS, "file"),
        )

    if not uploaded:
        if S.get(NS, "sig"):
            S.reset_from(NS, S.STEP_UPLOAD)
        return None

    sig = S.upload_sig(uploaded)
    if sig != S.get(NS, "sig"):
        S.reset_from(NS, S.STEP_UPLOAD)
        items = []
        files = uploaded if isinstance(uploaded, list) else [uploaded]
        for f in files:
            data = M.read_upload_bytes(f)
            try:
                meta = M.image_meta(data)
                items.append({
                    "name": f.name,
                    "bytes": data,
                    "meta": meta,
                })
            except Exception as ex:  # noqa: BLE001
                st.error(f"Could not read image {f.name}: {ex}")

        if not items:
            return None

        S.set_(NS, "sig", sig)
        S.set_(NS, "items", items)
        S.advance(NS, S.STEP_CONFIGURE)
    return S.get(NS, "items")


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
    items = None
    C.step_header(1, "Upload", active=True,
                  note="PNG · JPG · WEBP (Single or Multiple)")
    items = _staged_upload()

    if items:
        count = len(items)
        if count == 1:
            meta = items[0]["meta"]
            t, b, l, r = meta["pad"]
            C.spec_row([
                ("SOURCE", f"{meta['w']}×{meta['h']}",
                 f"{meta['orientation']} · {M.human_bytes(meta['bytes'])}"),
                ("TARGET", "3840×3840", "1:1 SQUARE"),
                ("PAD", f"L {l}  R {r}", f"T {t}  B {b}"),
            ])
            st.image(items[0]["bytes"], width=260)
        else:
            total_bytes = sum(it["meta"]["bytes"] for it in items)
            C.spec_row([
                ("BATCH", f"{count} IMAGES", M.human_bytes(total_bytes)),
                ("TARGET", "3840×3840 EACH", "1:1 SQUARE"),
                ("PARALLEL", "AUTO-SCALED", "CPU QUEUE"),
            ])
            cols = st.columns(min(count, 5))
            for idx, item in enumerate(items[:5]):
                with cols[idx % 5]:
                    st.image(item["bytes"], caption=item["name"], use_container_width=True)

    # ---------------------------------------------------------------- STEP 2
    live = S.step(NS) >= S.STEP_CONFIGURE
    C.step_header(2, "Configure", active=live)

    if not live:
        C.empty_state("AWAITING SOURCE",
                      "Drop one or more images above to unlock the pipeline settings.")
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
        btn_label = f"▶  RENDER {len(items or [])} IMAGE(S) 4K SQUARE" if items else "▶  RENDER 4K SQUARE"
        go = st.button(btn_label, type="primary",
                       disabled=disabled, key=S.wkey(NS, "go"),
                       width="stretch")

        if blocked:
            C.gated_reason(f"{blocked[0].label} UNAVAILABLE — SEE SYSTEM")
        elif missing_key:
            C.gated_reason("FAL KEY REQUIRED FOR OUTPAINTING — OR USE UPSCALE ONLY")

        if go and items:
            from pipeline.image_worker import process_image

            S.set_(NS, "running", True)
            items_kwargs = []
            for item in items:
                items_kwargs.append({
                    "name": item["name"],
                    "image_source": item["bytes"],
                    "prompt": None if upscale_only else prompt,
                    "fal_key": None if upscale_only else ctx["fal_key"],
                    "upscale_only": upscale_only,
                    "sharpening": sharpening,
                })

            raw_results = R.run_batch_pipeline(NS, "image", process_image, items_kwargs)
            S.set_(NS, "running", False)

            processed_results = []
            errors = []
            for item_info, (out, err) in zip(items, raw_results):
                if err:
                    errors.append((item_info["name"], err))
                elif out:
                    _url, path = out
                    rec = M.persist_result(path, "image", {
                        "mode": mode, "sharpening": sharpening, "name": item_info["name"],
                    })
                    rec["name"] = item_info["name"]
                    processed_results.append(rec)

            if processed_results:
                S.set_(NS, "results", processed_results)
                S.set_(NS, "result", processed_results[0])  # fallback for single
                S.advance(NS, S.STEP_RESULT)
            if errors:
                S.set_(NS, "error", (f"{len(errors)} ITEM(S) FAILED", errors[0][1][1]))
            else:
                S.clear(NS, "error")
            st.rerun()

    # ---------------------------------------------------------------- STEP 3
    results = S.get(NS, "results") or ([S.get(NS, "result")] if S.get(NS, "result") else None)
    err = S.get(NS, "error")
    C.step_header(3, "Result", active=bool(results))

    if err:
        headline, detail = err
        C.accent_block(headline, [detail])

    if not results:
        C.empty_state("NO RENDER YET",
                      "Configure the pipeline and render to produce 3840×3840 masters.")
        return

    C.result_header("03 / RESULT",
                    f"{len(results)} ITEM(S) PROCESSED · 3840×3840 · PNG")

    # Item selector if multiple results
    selected_result = results[0]
    if len(results) > 1:
        names = [f"{r.get('name', 'Item '+str(idx+1))} ({M.human_bytes(r['bytes'])})" for idx, r in enumerate(results)]
        sel_idx = st.selectbox("Select Result Item", list(range(len(names))), format_func=lambda i: names[i], key=S.wkey(NS, "item_sel"))
        selected_result = results[sel_idx]

    view = st.segmented_control(
        "View", ["AFTER", "SIDE BY SIDE"], default="AFTER",
        label_visibility="collapsed", key=S.wkey(NS, "resultview"),
    ) or "AFTER"

    # Find source bytes for side by side if available
    src_bytes = None
    if items:
        matching = [it for it in items if it["name"] == selected_result.get("name")]
        if matching:
            src_bytes = matching[0]["bytes"]

    if view == "SIDE BY SIDE" and src_bytes:
        a, b = st.columns(2)
        with a:
            C.eyebrow("SOURCE")
            st.image(src_bytes, width="stretch")
        with b:
            C.eyebrow("4K SQUARE")
            st.image(selected_result["path"], width="stretch")
    else:
        st.image(selected_result["path"], width="stretch")

    d1, d2 = st.columns([2, 1])
    with d1:
        fname = f"square_{selected_result.get('name', '4k_master.png')}"
        if not fname.endswith(".png"):
            fname += ".png"
        st.download_button(
            "↓  DOWNLOAD PNG",
            data=M.download_bytes(selected_result["path"]),
            file_name=fname,
            mime="image/png",
            type="primary",
            width="stretch",
            key=S.wkey(NS, f"dl_{selected_result['path']}"),
        )
    with d2:
        if st.button("↻  RUN AGAIN", key=S.wkey(NS, "again"), width="stretch"):
            S.reset_from(NS, S.STEP_CONFIGURE)
            st.rerun()

    C.mono(selected_result["path"])

