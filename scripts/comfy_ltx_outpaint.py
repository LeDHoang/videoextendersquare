#!/usr/bin/env python3
"""Local LTX-2.3 IC-LoRA in/outpainting via ComfyUI API (standalone, H100).

Template-driven: loads the stock
  ComfyUI/custom_nodes/ComfyUI-LTXVideo/example_workflows/2.3/
  LTX-2.3_ICLoRA_Outpaint_Two_Stage_Distilled.json
as a UI-graph, converts it to ComfyUI API-prompt format, applies runtime
overrides, submits to a local ComfyUI server (:8188) and fetches the result.

All heavy data stays on vol11-scratch (ComfyUI/models|input|output, .cache/).
Nothing here touches pipeline/ or server/ (later integration step).

Examples:
  # validate conversion only
  scripts/comfy_ltx_outpaint.py --dry-run
  # stock smoke test (uses bundled sample, no pre-processing)
  scripts/comfy_ltx_outpaint.py --stock --output output/smoke.mp4
  # real clip: trim 0-8s, outpaint to 1280x1280 square
  scripts/comfy_ltx_outpaint.py --input clip.mp4 --trim-start 0 \\
      --trim-duration 8 --target-width 1280 --target-height 1280 \\
      --prompt "city street at dusk" --seed 42 --output out.mp4
"""

import argparse
import copy
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

WS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COMFY = os.path.join(WS, "ComfyUI")
TEMPLATE = os.path.join(
    COMFY, "custom_nodes", "ComfyUI-LTXVideo", "example_workflows",
    "2.3", "LTX-2.3_ICLoRA_Outpaint_Two_Stage_Distilled.json")
TEMPLATE_25 = os.path.join(
    COMFY, "custom_nodes", "ComfyUI-LTXVideo", "example_workflows",
    "2.5", "LTX-2.5_ICLoRA_Outpaint_Two_Stage_Distilled.json")
SPEC_CACHE = os.path.join(WS, ".cache", "comfy_obj_specs.json")
COMFY_URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188")
sys.path.insert(0, os.path.join(WS, "scripts"))
from comfy_subgraph import (flatten_subgraphs as flatten_subgraphs_v2,
                            apply_literals as apply_literals_v2,
                            prune_enhancer)

WIDGET_TYPES = {"INT", "FLOAT", "STRING", "BOOLEAN"}
SKIP_TYPES = {"MarkdownNote", "Note", "PreviewAny"}


def _flatten_subgraphs_legacy(wf):
    """SUPERSEDED by scripts/comfy_subgraph.flatten_subgraphs (two-phase,
    handles instance->instance links). Kept until 2.5 path is green."""
    subs = {s["id"]: s for s in
            wf.get("definitions", {}).get("subgraphs", [])}
    if not subs:
        return {"nodes": wf["nodes"], "links": wf.get("links", [])}, []
    next_nid = wf.get("last_node_id", 0) + 1
    next_lid = wf.get("last_link_id", 0) + 1
    outer_links = {L[0]: L for L in wf.get("links", [])}
    skipped = set(SKIP_TYPES)

    def is_instance(n):
        return n["type"] in subs

    flat_nodes = [copy.deepcopy(n) for n in wf["nodes"]
                  if not is_instance(n)]
    flat_links = []
    literals = []
    kept_outer = set()  # outer link ids replaced by rewiring (dropped)

    def new_lid():
        nonlocal next_lid
        lid = next_lid
        next_lid += 1
        return lid

    def entries_by_name(node):
        return {e.get("name"): e for e in node.get("inputs", [])}

    for inst in [n for n in wf["nodes"] if is_instance(n)]:
        sg = subs[inst["type"]]
        where = f"instance {inst['id']} ({sg.get('name')})"
        # Reroute passthroughs: output_link -> input_link (chains resolved).
        alias = {}
        for rn in sg["nodes"]:
            if rn["type"] != "Reroute":
                continue
            ins = [e for e in rn.get("inputs", [])
                   if e.get("link") is not None]
            outs = [e for e in rn.get("outputs", [])
                    if e.get("links")]
            if len(ins) != 1:
                raise ValueError(f"{where}: Reroute {rn['id']} has "
                                 f"{len(ins)} inputs, expected 1")
            for e in outs:
                for lid in e["links"]:
                    alias[lid] = ins[0]["link"]

        def resolve(lid):
            seen = set()
            while lid in alias:
                if lid in seen:
                    raise ValueError(f"{where}: Reroute alias cycle "
                                     f"at link {lid}")
                seen.add(lid)
                lid = alias[lid]
            return lid

        inner = [n for n in sg["nodes"] if n["type"] != "Reroute"]
        remap = {}
        for n in inner:
            remap[n["id"]] = next_nid
            next_nid += 1
        # inner link id -> link dict (post-alias: drop reroute endpoints)
        ilinks = {}
        for L in sg["links"]:
            rid = resolve(L["id"])
            if rid != L["id"]:
                continue  # reroute-internal link, superseded by alias
            if L["origin_id"] == -10 or L["target_id"] == -20:
                ilinks[L["id"]] = L
            elif L["origin_id"] not in remap or L["target_id"] not in remap:
                raise ValueError(f"{where}: link {L['id']} touches "
                                 f"unknown/reroute node "
                                 f"{L['origin_id']}->{L['target_id']}")
            else:
                ilinks[L["id"]] = L

        # instance widget values <-> input defs (widget-exposed, def order).
        wvals = inst.get("widgets_values") or []
        ientries = entries_by_name(inst)
        defval = {}
        ji = 0
        for k, d in enumerate(sg.get("inputs", [])):
            e = ientries.get(d["name"])
            if e is None:
                raise ValueError(f"{where}: no instance input for "
                                 f"subgraph input {d['name']!r}")
            if "widget" in e:
                if ji >= len(wvals):
                    raise ValueError(f"{where}: widget {d['name']!r} "
                                     f"beyond widgets_values "
                                     f"(len {len(wvals)})")
                defval[k] = wvals[ji]
                ji += 1
        if ji != len(wvals):
            raise ValueError(f"{where}: consumed {ji} widgets_values, "
                             f"have {len(wvals)}")

        def boundary_in(k):
            """Source of subgraph input slot k ->
            ('link', outer_lid) or ('literal', value)."""
            d = sg["inputs"][k]
            e = ientries[d["name"]]
            if e.get("link") is not None:
                return ("link", e["link"])
            if k not in defval:
                raise ValueError(f"{where}: unlinked input "
                                 f"{d['name']!r} has no widget value")
            return ("literal", defval[k])

        outdefs = {d["name"]: (k, d) for k, d in
                   enumerate(sg.get("outputs", []))}
        oentries = {e.get("name"): e for e in inst.get("outputs", [])}

        # copy inner nodes with remapped ids; index new entries by name.
        new_by_old = {}
        for n in inner:
            c = copy.deepcopy(n)
            c["id"] = remap[n["id"]]
            new_by_old[n["id"]] = c
            flat_nodes.append(c)

        def find_entry(node, name):
            for e in node.get("inputs", []):
                if e.get("name") == name:
                    return e
            raise ValueError(f"{where}: node {node['id']} "
                             f"({node['type']}) has no input {name!r}")

        def emit(fr, fs, to, ts, typ):
            lid = new_lid()
            flat_links.append([lid, fr, fs, to, ts, typ])
            return lid

        for lid, L in ilinks.items():
            if L["id"] in alias:
                continue  # reroute output link, resolved at consumers
            # resolve origin
            if L["origin_id"] == -10:
                kind, src = boundary_in(L["origin_slot"])
                if kind == "link":
                    if src not in outer_links:
                        raise ValueError(f"{where}: outer link {src} "
                                         f"missing")
                    kept_outer.add(src)
                    o = outer_links[src]
                    origin = (o[1], o[2], o[5])
                else:
                    origin = ("literal", src)
            else:
                origin = ("node", remap[L["origin_id"]],
                          L["origin_slot"], L["type"])
            # resolve target: list of ("inner", new_nid, entry_name)
            # or ("outer", outer_nid, outer_slot, outer_old_lid).
            if L["target_id"] == -20:
                od = sg["outputs"][L["target_slot"]]
                if od["name"] not in oentries:
                    raise ValueError(f"{where}: no instance output for "
                                     f"subgraph output {od['name']!r}")
                targets = []
                for olid in oentries[od["name"]].get("links", []):
                    ol = outer_links.get(olid)
                    if ol is None:
                        raise ValueError(f"{where}: outer link {olid} "
                                         f"missing")
                    kept_outer.add(olid)
                    targets.append(("outer", ol[3], ol[4], olid))
            else:
                tn = new_by_old[L["target_id"]]
                tname = None
                for e in tn.get("inputs", []):
                    if e.get("link") == lid:
                        tname = e.get("name")
                        break
                if tname is None:
                    raise ValueError(f"{where}: inner node "
                                     f"{L['target_id']} has no entry "
                                     f"for link {lid}")
                targets = [("inner", remap[L["target_id"]], tname)]
            # emit
            if origin[0] == "node":
                fr, fs, typ = origin[1], origin[2], origin[3]
            else:
                fr, fs, typ = origin[0], origin[1], origin[2]
            for t in targets:
                if origin[0] == "literal":
                    if t[0] == "inner":
                        node = next(n for n in flat_nodes if n["id"] == t[1])
                        find_entry(node, t[2])["link"] = None
                        literals.append((t[1], t[2], origin[1]))
                    else:
                        node = next(n for n in flat_nodes if n["id"] == t[1])
                        fixed = False
                        oname = None
                        for e in node.get("inputs", []):
                            if e.get("link") == t[3]:
                                e["link"] = None
                                oname = e.get("name")
                                fixed = True
                        if not fixed:
                            raise ValueError(
                                f"{where}: outer node {t[1]} has no "
                                f"entry for link {t[3]}")
                        literals.append((t[1], oname, origin[1]))
                elif t[0] == "inner":
                    node = next(n for n in flat_nodes if n["id"] == t[1])
                    nl = emit(fr, fs, t[1], slot_of(node, t[2], lid), typ)
                    find_entry(node, t[2])["link"] = nl
                else:
                    nl = emit(fr, fs, t[1], t[2], typ)
                    node = next(n for n in flat_nodes if n["id"] == t[1])
                    fixed = False
                    for e in node.get("inputs", []):
                        if e.get("link") == t[3]:
                            e["link"] = nl
                            fixed = True
                    if not fixed:
                        raise ValueError(
                            f"{where}: outer node {t[1]} has no "
                            f"entry for link {t[3]}")

    # kept outer links first, then rebuild output link-lists from the
    # final link set; then drop links with vanished endpoints (e.g. into
    # skipped PreviewAny). Converter only resolves queried links.
    for L in wf.get("links", []):
        if L[0] not in kept_outer:
            flat_links.append(list(L))
    alive = {n["id"] for n in flat_nodes}
    flat_links = [L for L in flat_links if L[1] in alive and L[3] in alive]
    for n in flat_nodes:
        for si, o in enumerate(n.get("outputs", [])):
            o["links"] = [L[0] for L in flat_links
                          if L[1] == n["id"] and L[2] == si]
        for e in n.get("inputs", []):
            if (e.get("link") is not None
                    and not any(L[0] == e["link"] for L in flat_links)):
                e["link"] = None  # dangling -> widget/default path
    return {"nodes": flat_nodes, "links": flat_links}, literals


def slot_of(node, entry_name, old_lid):
    """Input-slot index of an entry (for building flat link rows)."""
    for si, e in enumerate(node.get("inputs", [])):
        if e.get("name") == entry_name:
            return si
    raise ValueError(f"node {node['id']}: no input {entry_name!r} "
                     f"(link {old_lid})")


def _apply_literals_legacy(prompt, literals):
    """SUPERSEDED by scripts/comfy_subgraph.apply_literals."""
    for nid, name, value in literals:
        key = str(nid)
        if key not in prompt:
            raise ValueError(f"literal target node {nid} missing "
                             f"from prompt")
        inputs = prompt[key]["inputs"]
        if name not in inputs:
            raise ValueError(f"literal {name!r} not in node {nid} "
                             f"inputs {sorted(inputs)}")
        inputs[name] = value
    return len(literals)


def api_get(path, timeout=30):
    with urllib.request.urlopen(COMFY_URL + path, timeout=timeout) as r:
        return json.load(r)


def api_post(path, payload, timeout=30):
    req = urllib.request.Request(
        COMFY_URL + path, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode()[:2000]
        except Exception:
            body = "<unreadable>"
        raise RuntimeError(f"POST {path} -> {e.code}: {body}") from e


def load_specs(types):
    """object_info per node type, cached on vol11 (.cache/)."""
    specs = {}
    if os.path.exists(SPEC_CACHE):
        try:
            specs = json.load(open(SPEC_CACHE))
        except Exception:
            specs = {}
    missing = [t for t in types if t not in specs]
    for t in missing:
        specs[t] = api_get(f"/object_info/{t}")[t]
    if missing:
        os.makedirs(os.path.dirname(SPEC_CACHE), exist_ok=True)
        json.dump(specs, open(SPEC_CACHE, "w"), indent=1)
    return specs


def is_dynamic_combo(spec):
    kind = spec[0] if isinstance(spec, list) and spec else None
    return isinstance(kind, str) and "DYNAMICCOMBO" in kind


def is_widget_input(spec):
    """True if an INPUT_TYPES entry creates a widget (vs a link socket)."""
    kind = spec[0] if isinstance(spec, list) and spec else None
    if isinstance(kind, list):
        return True  # combo options
    if kind in WIDGET_TYPES or kind == "COMBO":
        return True
    if isinstance(kind, str) and "DYNAMICCOMBO" in kind:
        return True
    return False


def spec_default(idef):
    if isinstance(idef, list) and len(idef) > 1 and isinstance(idef[1], dict):
        return idef[1].get("default")
    return None


def is_hidden(idef):
    """Hidden inputs have no widget in the UI graph, so they never consume
    a positional widgets_values slot (e.g. SaveVideo's legacy top-level
    `codec` dynamic combo, hidden:true). They are only emitted when linked."""
    return (isinstance(idef, list) and len(idef) > 1
            and isinstance(idef[1], dict) and idef[1].get("hidden"))


class Cursor:
    """Positional widgets_values consumer with default-fill + action-drop."""

    def __init__(self, values, where):
        self.values = list(values)
        self.i = 0
        self.where = where

    def nxt(self, key, idef):
        if self.i < len(self.values):
            v = self.values[self.i]
            self.i += 1
            return v
        d = spec_default(idef)
        if d is not None:
            print(f"{self.where}: {key} absent from widgets_values, "
                  f"using spec default {d!r}", file=sys.stderr)
            return d
        raise ValueError(f"{self.where}: no value for {key!r} and no default")

    def finish(self):
        if self.i < len(self.values):
            print(f"{self.where}: dropping {len(self.values) - self.i} "
                  f"trailing action widget(s): {self.values[self.i:]}",
                  file=sys.stderr)


def convert_node(n, spec, links):
    """One UI-graph node -> (class_type, api_inputs). Raises on ambiguity."""
    where = f"node {n['id']} ({n['type']})"
    entries = {e.get("name"): e for e in n.get("inputs", [])}
    cur = Cursor(n.get("widgets_values") or [], where)
    out = {}

    def link_val(entry):
        lid = entry.get("link")
        if lid not in links:
            raise ValueError(f"{where}: dangling link {lid}")
        src, slot = links[lid]
        return [str(src), slot]

    def walk_inputs(inputs_dict, prefix=""):
        for key, idef in inputs_dict.items():
            dkey = f"{prefix}{key}" if prefix else key
            entry = entries.get(dkey, entries.get(key))
            if entry is not None and entry.get("link") is not None:
                # Link wins over any widget (connected widget inputs still
                # serialize their stale value — consume and discard it).
                if is_widget_input(idef) or is_dynamic_combo(idef):
                    stale = cur.nxt(dkey, idef)
                    print(f"{where}: {dkey} link-driven, ignoring stale "
                          f"widget value {stale!r}", file=sys.stderr)
                out[dkey] = link_val(entry)
                continue
            if is_hidden(idef):
                continue  # no widget slot in UI graph; omit unless linked
            if is_dynamic_combo(idef):
                choice = cur.nxt(dkey, idef)
                opts = {o["key"]: o for o in
                        idef[1].get("options", [])} if len(idef) > 1 else {}
                if choice not in opts:
                    raise ValueError(f"{where}: unknown {dkey} option "
                                     f"{choice!r} (known: {sorted(opts)})")
                out[dkey] = choice
                sub = dict(opts[choice].get("inputs", {}).get("required", {}))
                sub.update(opts[choice].get("inputs", {}).get("optional", {}))
                walk_inputs(sub, prefix=f"{dkey}.")
            elif is_widget_input(idef):
                out[dkey] = cur.nxt(dkey, idef)
            else:
                continue  # unconnected non-widget input (e.g. mask)

    def walk(inputs_dict):
        walk_inputs(inputs_dict)

    req = spec.get("input", {}).get("required") or {}
    opt = spec.get("input", {}).get("optional") or {}
    walk(req)
    walk(opt)
    cur.finish()
    # every widget ref in node.inputs must resolve to an assigned key
    # (nested dynamic-combo inputs also satisfy their short name).
    for ename, e in entries.items():
        w = e.get("widget")
        if w and e.get("link") is None:
            ref = w.get("name", ename)
            if ref not in out and ename not in out and not any(
                    k == ref or k.endswith(f".{ref}") for k in out):
                raise ValueError(f"{where}: widget ref {ref!r} unassigned")
    return n["type"], out


def graph_to_api_prompt(wf):
    """Convert UI-graph workflow JSON to ComfyUI API prompt dict.

    Mirrors the frontend graphToPrompt rules:
      * skip muted (mode==4) nodes and display notes
      * linked inputs -> [from_node_id, from_slot]
      * widget-backed inputs -> widget value (matched by widget name;
        positional fallback for nodes with empty inputs[] like loaders)
    Raises on any unresolvable mapping (loud > wrong).
    """
    types = sorted({n["type"] for n in wf["nodes"]
                    if n["type"] not in SKIP_TYPES and n.get("mode") != 4})
    specs = load_specs(types)

    # link_id -> (from_node_id, from_slot_index)
    links = {}
    for n in wf["nodes"]:
        for si, o in enumerate(n.get("outputs", [])):
            for lid in (o.get("links") or []):
                links[lid] = (n["id"], si)

    prompt = {}
    for n in wf["nodes"]:
        if n.get("mode") == 4 or n["type"] in SKIP_TYPES:
            continue
        t = n["type"]
        if t not in specs:
            raise ValueError(f"node {n['id']}: no object_info for type {t!r} "
                             f"(custom node missing?)")
        ctype, inputs = convert_node(n, specs[t], links)
        prompt[str(n["id"])] = {"class_type": ctype, "inputs": inputs}
    return prompt


def find_nodes(prompt, class_type):
    return sorted([nid for nid, n in prompt.items()
                   if n["class_type"] == class_type], key=int)


def apply_overrides(prompt, args):
    """Patch the API prompt in place. Returns dict of applied changes."""
    applied = {}

    def one(class_type):
        ids = find_nodes(prompt, class_type)
        if len(ids) != 1:
            raise ValueError(f"expected 1 {class_type}, found {ids}")
        return ids[0]

    def pair(class_type):
        ids = find_nodes(prompt, class_type)
        if len(ids) != 2:
            raise ValueError(f"expected 2 {class_type}, found {ids}")
        return ids  # smaller id = stage 1 by construction of template

    if args.video_file:
        nid = one("LoadVideo")
        prompt[nid]["inputs"]["file"] = args.video_file
        applied["LoadVideo.file"] = args.video_file
    if args.ref_image:
        nid = one("LoadImage")
        prompt[nid]["inputs"]["image"] = args.ref_image
        applied["LoadImage.image"] = args.ref_image
    if args.prompt is not None or args.negative is not None:
        # role = which LTXVConditioning socket each encoder feeds
        role_of = {}
        for nid in find_nodes(prompt, "CLIPTextEncode"):
            for oid, o in prompt.items():
                for k, v in o["inputs"].items():
                    if (isinstance(v, list) and v[0] == nid
                            and o["class_type"] == "LTXVConditioning"):
                        role_of[nid] = k
        for nid, role in role_of.items():
            if role == "positive" and args.prompt is not None:
                prompt[nid]["inputs"]["text"] = args.prompt
                applied[f"CLIPTextEncode.{nid}.text"] = args.prompt
            if role == "negative" and args.negative is not None:
                prompt[nid]["inputs"]["text"] = args.negative
                applied[f"CLIPTextEncode.{nid}.text"] = args.negative
    if args.seed is not None:
        for nid in find_nodes(prompt, "RandomNoise"):
            prompt[nid]["inputs"]["noise_seed"] = args.seed
            applied[f"RandomNoise.{nid}"] = args.seed
    if args.target_width or args.target_height or args.feathering is not None:
        nid = one("ImagePadForOutpaintTargetSize")
        cur = prompt[nid]["inputs"]
        if args.target_width:
            cur["target_width"] = args.target_width
        if args.target_height:
            cur["target_height"] = args.target_height
        if args.feathering is not None:
            cur["feathering"] = args.feathering
        applied["ImagePad"] = {k: cur[k] for k in
                               ("target_width", "target_height", "feathering")
                               if k in cur}
    if args.cfg is not None:
        for nid in find_nodes(prompt, "CFGGuider"):
            prompt[nid]["inputs"]["cfg"] = args.cfg
            applied[f"CFGGuider.{nid}.cfg"] = args.cfg
    if args.sampler:
        for nid in find_nodes(prompt, "KSamplerSelect"):
            prompt[nid]["inputs"]["sampler_name"] = args.sampler
            applied[f"KSamplerSelect.{nid}"] = args.sampler
    if args.sigmas_s1 or args.sigmas_s2:
        ids = pair("ManualSigmas")
        # longer schedule = stage 1
        s1 = max(ids, key=lambda i: len(str(prompt[i]["inputs"]["sigmas"])))
        s2 = min(ids, key=lambda i: len(str(prompt[i]["inputs"]["sigmas"])))
        if args.sigmas_s1:
            prompt[s1]["inputs"]["sigmas"] = args.sigmas_s1
            applied["sigmas_s1"] = args.sigmas_s1
        if args.sigmas_s2:
            prompt[s2]["inputs"]["sigmas"] = args.sigmas_s2
            applied["sigmas_s2"] = args.sigmas_s2
    if args.distilled_strength is not None or args.iclora_strength is not None:
        for nid in find_nodes(prompt, "LoraLoaderModelOnly"):
            if args.distilled_strength is not None:
                prompt[nid]["inputs"]["strength_model"] = \
                    args.distilled_strength
                applied["distilled_lora.strength"] = args.distilled_strength
        for nid in find_nodes(prompt, "LTXICLoRALoaderModelOnly"):
            if args.iclora_strength is not None:
                prompt[nid]["inputs"]["strength_model"] = args.iclora_strength
                applied["iclora.strength"] = args.iclora_strength
    if args.guide_strength is not None or args.attention_strength is not None:
        nid = one("LTXAddVideoICLoRAGuideAdvanced")
        if args.guide_strength is not None:
            prompt[nid]["inputs"]["strength"] = args.guide_strength
            applied["guide.strength"] = args.guide_strength
        if args.attention_strength is not None:
            prompt[nid]["inputs"]["attention_strength"] = \
                args.attention_strength
            applied["guide.attention_strength"] = args.attention_strength
    if args.fps:
        for cls, key in (("CreateVideo", "fps"),
                         ("LTXVConditioning", "frame_rate")):
            for nid in find_nodes(prompt, cls):
                prompt[nid]["inputs"][key] = float(args.fps)
                applied[f"{cls}.{nid}.{key}"] = float(args.fps)
    if args.video_vae == "conv":
        swapped = False
        for nid in find_nodes(prompt, "VAELoader"):
            cur = prompt[nid]["inputs"].get("vae_name", "")
            if "video-vae" in cur and "conv" not in cur:
                prompt[nid]["inputs"]["vae_name"] = \
                    "ltx-2.5-video-vae-conv-bf16.safetensors"
                applied[f"VAELoader.{nid}"] = "conv"
                swapped = True
        if not swapped:
            print("warning: --video-vae conv found no 2.5 video VAE "
                  "to swap (2.3 template?)", file=sys.stderr)
    if args.blend_dilation is not None:
        for nid in find_nodes(prompt, "LTXVLaplacianPyramidBlend"):
            prompt[nid]["inputs"]["mask_low_res_dilation"] = \
                args.blend_dilation
            applied[f"LTXVLaplacianPyramidBlend.{nid}.dilation"] = \
                args.blend_dilation
    if args.prefix:
        nid = one("SaveVideo")
        prompt[nid]["inputs"]["filename_prefix"] = args.prefix
        applied["SaveVideo.prefix"] = args.prefix
    return applied


STOCK_VIDEO_URL = ("https://media.githubusercontent.com/media/Lightricks/"
                   "ComfyUI-LTXVideo/master/example_workflows/assets/"
                   "outpainting_input.mp4")


def _looks_like_lfs_pointer(path):
    try:
        with open(path, "rb") as f:
            head = f.read(120)
        return b"git-lfs.github.com/spec/v1" in head
    except OSError:
        return False


def _ffprobe_ok(path):
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                            "format=duration", "-of", "csv=p=0", path],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           timeout=60)
        return r.returncode == 0 and r.stdout.strip()
    except Exception:
        return False


def _has_audio(path):
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a",
                            "-show_entries", "stream=index",
                            "-of", "csv=p=0", path],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           timeout=60)
        return r.returncode == 0 and bool(r.stdout.strip())
    except Exception:
        return False


def _ensure_audio_track(dst):
    """Mux a silent AAC track if the clip has none.

    The stock two-stage graph always runs the audio-VAE path
    (`VAEEncodeAudio` hard-fails on `audio=None`), so silent sources must
    carry an empty track. Video stream is copied, not re-encoded.
    """
    if _has_audio(dst):
        return False
    tmp = dst + ".withaudio.mp4"
    subprocess.run(["ffmpeg", "-y", "-i", dst, "-f", "lavfi", "-i",
                    "anullsrc=r=48000:cl=stereo", "-c:v", "copy",
                    "-c:a", "aac", "-shortest",
                    "-movflags", "+faststart", tmp],
                   check=True, stdout=subprocess.PIPE,
                   stderr=subprocess.PIPE)
    os.replace(tmp, dst)
    print(f"staged {dst}: no audio in source, muxed silent AAC track")
    return True


def prepare_inputs(args):
    """Trim (ffmpeg) + stage files into ComfyUI/input/. Returns
    (video_file, ref_image) basenames. --stock skips pre-processing."""
    input_dir = os.path.join(COMFY, "input")
    os.makedirs(input_dir, exist_ok=True)
    if args.stock:
        dst = os.path.join(input_dir, "outpainting_input.mp4")
        # Shallow clones lack git-lfs, so the bundled asset dir holds a
        # 132-byte LFS pointer, not a video. Re-fetch real bytes if needed.
        if (not os.path.exists(dst) or _looks_like_lfs_pointer(dst)
                or not _ffprobe_ok(dst)):
            src = os.path.join(
                COMFY, "custom_nodes", "ComfyUI-LTXVideo",
                "example_workflows", "assets", "outpainting_input.mp4")
            if (os.path.exists(src) and not _looks_like_lfs_pointer(src)
                    and _ffprobe_ok(src)):
                shutil.copy(src, dst)
            else:
                subprocess.run(["curl", "-sL", "--max-time", "300",
                                "-o", dst, STOCK_VIDEO_URL], check=True)
            if not _ffprobe_ok(dst):
                raise RuntimeError(
                    f"stock sample {dst} is not a readable video "
                    f"(git-lfs pointer?); fetch it manually and retry")
        if not os.path.exists(os.path.join(input_dir, "example.png")):
            raise RuntimeError("ComfyUI/input/example.png missing")
        return "outpainting_input.mp4", "example.png"  # already in input/
    if not args.input:
        raise ValueError("--input required (or --stock)")
    tag = args.prefix or f"ltx_{int(time.time())}"
    base = f"{tag}_src.mp4"
    dst = os.path.join(input_dir, base)
    trim = ["ffmpeg", "-y", "-ss", str(args.trim_start), "-i", args.input,
            "-t", str(args.trim_duration), "-c", "copy",
            "-movflags", "+faststart", dst]
    try:
        subprocess.run(trim, check=True, stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE)
        if not os.path.exists(dst) or os.path.getsize(dst) == 0:
            raise OSError("stream-copy produced empty file")
    except Exception:
        subprocess.run(["ffmpeg", "-y", "-ss", str(args.trim_start), "-i",
                        args.input, "-t", str(args.trim_duration),
                        "-c:v", "libx264", "-preset", "fast", "-crf", "17",
                        "-c:a", "copy", dst],
                        check=True, stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE)
    _ensure_audio_track(dst)  # stock graph needs an audio stream (see def)
    ref = f"{tag}_ref.png"
    subprocess.run(["ffmpeg", "-y", "-i", dst, "-vframes", "1", "-q:v", "2",
                    os.path.join(input_dir, ref)],
                   check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return base, ref


def submit_and_wait(prompt, timeout_s=3600, poll_s=5):
    res = api_post("/prompt", {"prompt": prompt})
    pid = res["prompt_id"]
    print(f"queued prompt_id={pid}")
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        time.sleep(poll_s)
        try:
            hist = api_get(f"/history/{pid}", timeout=30)
        except Exception as e:
            print(f"history poll: {e}")
            continue
        if pid in hist:
            entry = hist[pid]
            if entry.get("status", {}).get("completed"):
                return pid, entry
            if entry.get("status", {}).get("status_str") == "error":
                raise RuntimeError(f"prompt failed: {entry['status']}")
        el = time.time() - t0
        print(f"  ... {el:.0f}s elapsed")
    raise TimeoutError(f"prompt {pid} not done after {timeout_s}s")


def resolve_outputs(prompt, entry):
    """Files produced by the SaveVideo node(s) under ComfyUI/output/.

    Only SaveVideo outputs count: passthrough nodes such as LoadVideo also
    appear in history['outputs'] but reference files in ComfyUI/input/.
    """
    save_ids = set(find_nodes(prompt, "SaveVideo"))
    files = []
    for nid, nout in (entry.get("outputs") or {}).items():
        if save_ids and str(nid) not in save_ids:
            continue
        for key in ("video", "gifs", "images"):
            for item in (nout.get(key) or []):
                sub = item.get("subfolder", "")
                path = os.path.join(COMFY, "output", sub, item["filename"])
                files.append(path)
    return files


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dry-run", action="store_true",
                    help="convert template + validate, don't queue")
    ap.add_argument("--template", choices=("2.3", "2.5"), default="2.3",
                    help="which example workflow to convert "
                    "(2.5 subgraphs are flattened first)")
    ap.add_argument("--stock", action="store_true",
                    help="use bundled sample media, skip pre-processing")
    ap.add_argument("--input", default=None, help="source video path")
    ap.add_argument("--trim-start", type=float, default=0.0)
    ap.add_argument("--trim-duration", type=float, default=8.0)
    ap.add_argument("--target-width", type=int, default=None)
    ap.add_argument("--target-height", type=int, default=None)
    ap.add_argument("--feathering", type=int, default=None)
    ap.add_argument("--fps", type=float, default=None)
    ap.add_argument("--prompt", default=None)
    ap.add_argument("--negative", default=None)
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--cfg", type=float, default=None)
    ap.add_argument("--sampler", default=None)
    ap.add_argument("--sigmas-s1", default=None)
    ap.add_argument("--sigmas-s2", default=None)
    ap.add_argument("--distilled-strength", type=float, default=None)
    ap.add_argument("--iclora-strength", type=float, default=None)
    ap.add_argument("--guide-strength", type=float, default=None)
    ap.add_argument("--attention-strength", type=float, default=None)
    ap.add_argument("--blend-dilation", type=int, default=15,
                    help="mask_low_res_dilation for both "
                    "LTXVLaplacianPyramidBlend stages (template: 5/2; "
                    "15 = max, recommended: widest blend, least visible "
                    "seam; pass 5 to reproduce template behavior)")
    ap.add_argument("--video-vae", choices=("diff", "conv"), default="diff",
                    help="2.5 only: diffusion video VAE (best) vs conv VAE "
                    "(low-mem fallback; downloads on first use)")
    ap.add_argument("--prefix", default=None,
                    help="SaveVideo filename prefix (also tags staged files)")
    ap.add_argument("--output", default=None,
                    help="where to copy the finished video")
    ap.add_argument("--timeout", type=int, default=3600)
    args = ap.parse_args()

    wf = json.load(open(TEMPLATE_25 if args.template == "2.5"
                          else TEMPLATE))
    if args.template == "2.5":
        flat, literals = flatten_subgraphs_v2(wf)
        print(f"flattened {len(wf['nodes'])} outer + "
              f"{sum(len(s.get('nodes', [])) for s in wf['definitions']['subgraphs'])} "
              f"inner -> {len(flat['nodes'])} nodes, "
              f"{len(literals)} boundary literals)")
        wf = flat
    else:
        literals = []
    prompt = graph_to_api_prompt(wf)
    print(f"converted {len(prompt)} nodes "
          f"(skipped {len(wf['nodes']) - len(prompt)} muted/note)")
    if literals:
        n = apply_literals_v2(prompt, literals)
        print(f"applied {n} boundary literals")
    if args.template == "2.5":
        n = prune_enhancer(prompt)
        print(f"pruned {n} enhancer nodes (template default Enhance=false; "
              f"raw prompt path kept)")
        # 2.5 template stores the IC-LoRA as a bare filename, but the
        # loader validates against loras/-relative paths (2.3 template
        # already carries the ltxv/ltx2/ prefix).
        for nid in find_nodes(prompt, "LTXICLoRALoaderModelOnly"):
            cur = prompt[nid]["inputs"].get("lora_name", "")
            if "/" not in cur:
                prompt[nid]["inputs"]["lora_name"] = \
                    f"ltxv/ltx2/{cur}"
                print(f"prefixed IC-LoRA {nid}: {cur} -> ltxv/ltx2/{cur}")

    if args.dry_run:
        print(json.dumps(prompt, indent=1)[:2000])
        print("... dry-run OK")
        return

    video_file, ref_image = prepare_inputs(args)
    args.video_file, args.ref_image = video_file, ref_image
    if not args.prefix:
        args.prefix = f"ltx_out_{int(time.time())}"
    applied = apply_overrides(prompt, args)
    print("overrides:", json.dumps(applied, indent=1))

    t0 = time.time()
    pid, entry = submit_and_wait(prompt, timeout_s=args.timeout)
    files = resolve_outputs(prompt, entry)
    print(f"done in {time.time() - t0:.0f}s, outputs: {files}")
    if args.output and files:
        shutil.copy(files[0], args.output)
        print(f"copied -> {args.output}")


if __name__ == "__main__":
    main()
