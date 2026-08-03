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
            "Drop videos",
            type=sorted(M.VIDEO_EXTS),
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
            path = M.stage_video(f)
            try:
                meta = M.video_meta(path)
                items.append({
                    "name": f.name,
                    "path": path,
                    "meta": meta,
                })
            except Exception as ex:  # noqa: BLE001
                M.discard_staged(path)
                st.error(f"Could not read video {f.name}: {ex}")

        if not items:
            return None

        S.set_(NS, "sig", sig)
        S.set_(NS, "items", items)
        S.advance(NS, S.STEP_CONFIGURE)
    return S.get(NS, "items")


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
    items = None
    C.step_header(1, "Upload", active=True, note="MP4 · MOV · AVI · WEBM (Single or Multiple)")
    items = _staged_upload()

    if items:
        count = len(items)
        if count == 1:
            meta = items[0]["meta"]
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
                     "throttles long clips, so render time grows faster than duration."],
                    tone="warn",
                )
            st.video(items[0]["path"])
        else:
            total_bytes = sum(it["meta"]["bytes"] for it in items)
            total_dur = sum(it["meta"]["dur"] for it in items)
            C.spec_row([
                ("BATCH", f"{count} VIDEOS", M.human_bytes(total_bytes)),
                ("TOTAL DUR", f"{total_dur:.1f}s", f"Avg {total_dur/count:.1f}s"),
                ("TARGET", "3840×3840 EACH", "1:1 SQUARE"),
                ("PARALLEL", "AUTO-QUEUED", "RESOURCES"),
            ])
            cols = st.columns(min(count, 4))
            for idx, item in enumerate(items[:4]):
                with cols[idx % 4]:
                    st.caption(f"**{item['name']}** ({item['meta']['dur']:.1f}s)")
                    st.video(item["path"])

    # ---------------------------------------------------------------- STEP 2
    live = S.step(NS) >= S.STEP_CONFIGURE
    C.step_header(2, "Configure", active=live)

    if not live:
        C.empty_state("AWAITING SOURCE",
                      "Drop one or more videos above to unlock the pipeline settings.")
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
            "matching texture and lighting. Keep the origin video aethestic and lighting"
        )
        outpaint_model_id = ctx["models"]["outpaint_vid"]
        ltx_resolution = "720p"
        ltx_audio = True

        if not upscale_only:
            C.eyebrow("OUTPAINT MODEL")
            outpaint_options = {
                "LTX 2.3 Quality": "fal-ai/ltx-2.3-quality/outpaint",
                "Luma Ray-2 Reframe": "fal-ai/luma-dream-machine/ray-2-flash/reframe",
                "Kling Video": "fal-ai/klingx",
            }
            selected_outpaint = st.segmented_control(
                "Outpaint Model Options",
                list(outpaint_options.keys()),
                default="LTX 2.3 Quality",
                label_visibility="collapsed",
                key=S.wkey(NS, "fal_outpaint_model_opt"),
            ) or "LTX 2.3 Quality"
            outpaint_model_id = outpaint_options[selected_outpaint]

            C.eyebrow("PROMPT")
            prompt = st.text_area(
                "Outpaint prompt", value=prompt, label_visibility="collapsed",
                key=S.wkey(NS, "prompt"), height=100,
            )
            S.set_(NS, "prompt_cache", prompt)

            if "ltx" in outpaint_model_id.lower():
                with st.expander("▸ LTX 2.3 OUTPAINT SETTINGS", expanded=False):
                    cl1, cl2 = st.columns(2)
                    with cl1:
                        ltx_resolution = st.selectbox(
                            "Output Resolution Tier", ["720p", "1080p", "480p"],
                            key=S.wkey(NS, "ltx_res"),
                            help="Canvas resolution tier for LTX 2.3 Outpaint."
                        )
                    with cl2:
                        ltx_audio = st.toggle(
                            "Include Audio Track", value=True,
                            key=S.wkey(NS, "ltx_audio")
                        )

        C.eyebrow("UPSCALE ENGINE")
        engine = st.segmented_control(
            "Engine", ["FAST", "STUDIO", "FAL AI"], default="FAST",
            label_visibility="collapsed", key=S.wkey(NS, "engine"),
        ) or "FAST"
        studio_picked = engine == "STUDIO"
        fal_picked = engine == "FAL AI"

        fal_upscale_model = ctx["models"]["upscale_vid"]
        seedvr_factor = 2.0
        seedvr_target = "1080p"
        if fal_picked:
            C.eyebrow("FAL AI UPSCALE MODEL")
            fal_options = {
                "SeedVR2 Video": "fal-ai/seedvr/upscale/video",
                "Kling Video": "fal-ai/kling-video/v1.5/pro/upscale",
                "ESRGAN Video": "fal-ai/esrgan-video",
            }
            selected_opt = st.segmented_control(
                "FAL AI Model Options",
                list(fal_options.keys()),
                default="SeedVR2 Video",
                label_visibility="collapsed",
                key=S.wkey(NS, "fal_vid_model"),
            ) or "SeedVR2 Video"
            fal_upscale_model = fal_options[selected_opt]

            if "seedvr" in fal_upscale_model.lower():
                with st.expander("▸ SEEDVR2 UPSCALE SETTINGS", expanded=False):
                    cs1, cs2 = st.columns(2)
                    with cs1:
                        seedvr_factor = st.slider(
                            "Upscale Factor", 1.0, 4.0, 2.0, 0.5,
                            key=S.wkey(NS, "seedvr_factor"),
                            help="Dimension multiplier when upscale mode is factor."
                        )
                    with cs2:
                        seedvr_target = st.selectbox(
                            "Target Resolution Tier", ["1080p", "2160p", "1440p", "720p"],
                            key=S.wkey(NS, "seedvr_target")
                        )

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

        C.eyebrow("TRIM INPUT VIDEO (MAX 15 SECONDS)")
        max_source_dur = max([item["meta"]["dur"] for item in items]) if items else 60.0
        c_tr1, c_tr2 = st.columns([1, 2])
        with c_tr1:
            trim_enabled = st.toggle(
                "Enable 15s Trimming",
                value=False,
                key=S.wkey(NS, "trim_enabled"),
                help="Extracts a sub-clip of at most 15 seconds from the input video."
            )
        trim_start = 0.0
        trim_duration = 15.0
        if trim_enabled:
            with c_tr2:
                t1, t2 = st.columns(2)
                with t1:
                    trim_start = st.number_input(
                        "Start Time (s)",
                        min_value=0.0,
                        max_value=max(0.0, max_source_dur - 1.0),
                        value=0.0,
                        step=0.5,
                        key=S.wkey(NS, "trim_start"),
                    )
                with t2:
                    trim_duration = st.slider(
                        "Clip Length (max 15s)",
                        min_value=1.0,
                        max_value=15.0,
                        value=min(15.0, max(1.0, max_source_dur - trim_start)),
                        step=0.5,
                        key=S.wkey(NS, "trim_duration"),
                    )

        needs_key = (not upscale_only) or fal_picked
        missing_key = needs_key and not ctx["fal"].ok
        studio_blocked = studio_picked and not studio_ok
        disabled = (bool(blocked) or missing_key or studio_blocked
                    or S.get(NS, "running", False))

        st.markdown("")
        btn_label = f"▶  RENDER {len(items or [])} VIDEO(S) 4K SQUARE" if items else "▶  RENDER 4K SQUARE"

        go = st.button(btn_label, type="primary", disabled=disabled,
                       key=S.wkey(NS, "go"), width="stretch")

        if blocked:
            C.gated_reason(f"{blocked[0].label} UNAVAILABLE — SEE SYSTEM")
        elif studio_blocked:
            C.gated_reason("STUDIO ENGINE NOT INSTALLED — SWITCH TO FAST OR FAL AI")
        elif missing_key:
            C.gated_reason("FAL KEY REQUIRED FOR OUTPAINTING / FAL AI UPSCALE")

        if go and items:
            from pipeline.video_worker import process_video

            S.set_(NS, "running", True)
            items_kwargs = []
            for item in items:
                items_kwargs.append({
                    "name": item["name"],
                    "video_path": item["path"],
                    "prompt": None if upscale_only else prompt,
                    "fal_key": ctx["fal_key"] if needs_key else None,
                    "outpaint_model": None if upscale_only else outpaint_model_id,
                    "upscale_model": fal_upscale_model if fal_picked else ctx["models"]["upscale_vid"],
                    "upscale_only": upscale_only,
                    "sharpening": sharpening,
                    "upscale_engine": "fal" if fal_picked else ("studio" if studio_picked else "fast"),
                    "ltx_resolution": ltx_resolution,
                    "ltx_audio": ltx_audio,
                    "seedvr_factor": seedvr_factor,
                    "seedvr_target": seedvr_target,
                    "trim_enabled": trim_enabled,
                    "trim_start": trim_start,
                    "trim_duration": trim_duration,
                })

            raw_results = R.run_batch_pipeline(NS, "video", process_video, items_kwargs)
            S.set_(NS, "running", False)

            processed_results = []
            errors = []
            for item_info, (out, err) in zip(items, raw_results):
                if err:
                    errors.append((item_info["name"], err))
                elif out:
                    if isinstance(out, tuple) and len(out) == 2 and isinstance(out[1], dict):
                        (out_urls, path), metrics = out
                    else:
                        _url, path = out
                        metrics = {}

                    rec = M.persist_result(path, "video", {
                        "mode": mode, "engine": engine, "sharpening": sharpening, "name": item_info["name"],
                    })
                    rec["name"] = item_info["name"]
                    rec["metrics"] = metrics

                    from pipeline.utils import log_pipeline_execution
                    log_pipeline_execution(
                        item_name=item_info["name"],
                        kind="video",
                        input_path=item_info["path"],
                        output_path=rec["path"],
                        metrics=metrics,
                        params={"mode": mode, "engine": engine, "sharpening": sharpening}
                    )
                    if probes["libx264"].ok:
                        with st.spinner(f"Building preview proxy for {item_info['name']}…"):
                            rec["preview"] = M.make_web_preview(rec["path"])
                    processed_results.append(rec)

            if processed_results:
                S.set_(NS, "results", processed_results)
                S.set_(NS, "result", processed_results[0])
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
                      "Configure the pipeline and render to produce 3840×3840 video masters.")
        return

    C.result_header(
        "03 / RESULT",
        f"{len(results)} ITEM(S) PROCESSED · 3840×3840 · HEVC MP4",
    )

    selected_result = results[0]
    if len(results) > 1:
        names = [f"{r.get('name', 'Item '+str(idx+1))} ({M.human_bytes(r['bytes'])})" for idx, r in enumerate(results)]
        sel_idx = st.selectbox("Select Result Item", list(range(len(names))), format_func=lambda i: names[i], key=S.wkey(NS, "item_sel"))
        selected_result = results[sel_idx]

    metrics = selected_result.get("metrics")
    if metrics:
        total_time = metrics.get("total_time", 0.0)
        total_cost = metrics.get("total_cost", 0.0)
        st.markdown(
            f"""
            <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 8px; padding: 14px; margin-bottom: 16px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                    <span style="font-weight: 700; font-size: 13px; letter-spacing: 0.05em; color: #fff;">⚡ PERFORMANCE & CLOUD COST LOG</span>
                    <span style="font-family: monospace; font-size: 13px; color: #4ade80; background: rgba(74, 222, 128, 0.1); padding: 4px 10px; border-radius: 4px;">
                        ⏱ {total_time}s &nbsp;•&nbsp; 💰 Est. ${total_cost:.4f} USD
                    </span>
                </div>
                <div style="font-family: monospace; font-size: 12px; line-height: 1.7; color: #a1a1aa;">
                    <div>• <b>Upload to CDN:</b> {metrics.get('upload_time', 0.0)}s &nbsp;(Cost: $0.00)</div>
                    <div>• <b>Outpaint ({metrics.get('outpaint_model')}):</b> {metrics.get('outpaint_time', 0.0)}s &nbsp;(Cost: ${metrics.get('outpaint_cost', 0.0):.4f})</div>
                    <div>• <b>Upscale ({metrics.get('upscale_model')}):</b> {metrics.get('upscale_time', 0.0)}s &nbsp;(Cost: ${metrics.get('upscale_cost', 0.0):.4f})</div>
                    <div>• <b>4K HEVC Master Encode:</b> {metrics.get('master_time', 0.0)}s &nbsp;(Cost: $0.00 Local)</div>
                </div>
            </div>
            """,
            unsafe_allow_html=True
        )

    if selected_result.get("preview"):
        st.video(selected_result["preview"])
        C.eyebrow("PREVIEW IS AN H.264 PROXY · DOWNLOAD FOR THE HEVC MASTER")
    else:
        C.accent_block(
            "NO BROWSER PREVIEW",
            ["The master is HEVC, which most browsers cannot decode, and an "
             "H.264 proxy could not be built. Download the file to view it."],
        )

    d1, d2, d3 = st.columns([2, 2, 1])
    with d1:
        fname = f"square_{selected_result.get('name', 'extended_4k_video.mp4')}"
        if not fname.endswith(".mp4"):
            fname += ".mp4"
        st.download_button(
            "↓  DOWNLOAD MASTER (HEVC)",
            data=M.download_bytes(selected_result["path"]),
            file_name=fname, mime="video/mp4",
            type="primary", width="stretch", key=S.wkey(NS, f"dl_{selected_result['path']}"),
        )
        st.caption("Full 4K · 3840×3840 · HEVC/H.265 Master")
    with d2:
        if selected_result.get("preview"):
            st.download_button(
                "↓  PROXY (H.264)",
                data=M.download_bytes(selected_result["preview"]),
                file_name=f"preview_{fname}", mime="video/mp4",
                width="stretch", key=S.wkey(NS, f"dlp_{selected_result['path']}"),
            )
            st.caption("Web Proxy · 1080p · Universal H.264 Playback")

    with d3:
        if st.button("↻  RUN AGAIN", key=S.wkey(NS, "again"), width="stretch"):
            S.reset_from(NS, S.STEP_CONFIGURE)
            st.rerun()


    C.mono(selected_result["path"])

