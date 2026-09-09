"""Subgraph flattening for ComfyUI 2.5 example workflows (LTX-2.5).

2.5 workflows wrap stages in `definitions.subgraphs`; instances are
top-level nodes whose `type` is a subgraph id. The API prompt converter in
comfy_ltx_outpaint.py only handles flat graphs, so each instance is replaced
by its inner nodes (remapped ids), boundary links are rewired to outer links
(instance->instance chains resolved recursively), Reroute passthroughs are
eliminated, and widget-valued (unlinked) boundary inputs are recorded as
literals to set on the converted prompt.

Two phases: A expands all instances (no wiring, so ordering never matters),
B wires inner->inner links plus every outer link touching an instance.
Anything unresolvable raises loudly (loud > wrong).
"""

import copy


def slot_of(node, entry_name, old_lid):
    """Input-slot index of an entry (== position in inputs[])."""
    for si, e in enumerate(node.get("inputs", [])):
        if e.get("name") == entry_name:
            return si
    raise ValueError(f"node {node['id']}: no input {entry_name!r} "
                     f"(link {old_lid})")


def find_entry(node, name):
    for e in node.get("inputs", []):
        if e.get("name") == name:
            return e
    raise ValueError(f"node {node['id']} ({node['type']}) "
                     f"has no input {name!r}")


def flatten_subgraphs(wf):
    """See module docstring. Returns (flat_wf, literals)."""
    subs = {s["id"]: s for s in
            wf.get("definitions", {}).get("subgraphs", [])}
    if not subs:
        return {"nodes": wf["nodes"], "links": wf.get("links", [])}, []
    next_nid = wf.get("last_node_id", 0) + 1
    next_lid = wf.get("last_link_id", 0) + 1
    outer_links = {L[0]: L for L in wf.get("links", [])}

    def is_instance(n):
        return n["type"] in subs

    flat_nodes = [copy.deepcopy(n) for n in wf["nodes"]
                  if not is_instance(n)]
    node_by_id = {n["id"]: n for n in flat_nodes}
    flat_links = []
    literals = []
    kept_outer = set()

    def new_lid():
        nonlocal next_lid
        lid = next_lid
        next_lid += 1
        return lid

    def emit(fr, fs, to, ts, typ):
        lid = new_lid()
        flat_links.append([lid, fr, fs, to, ts, typ])
        return lid

    # ---- Phase A: expand ------------------------------------------------
    infos = {}
    for inst in [n for n in wf["nodes"] if is_instance(n)]:
        sg = subs[inst["type"]]
        where = f"instance {inst['id']} ({sg.get('name')})"
        # Reroute passthroughs: synthesize effective links (origin of the
        # reroute's input link -> target of its output link). Single level;
        # chains raise loudly.
        reroute_ids = {n["id"] for n in sg["nodes"]
                       if n["type"] == "Reroute"}
        rin = {}
        for x in sg["links"]:
            if x["target_id"] in reroute_ids:
                if x["target_id"] in rin:
                    raise ValueError(f"{where}: Reroute {x['target_id']} "
                                     f"has >1 input link")
                rin[x["target_id"]] = x
        eff_links = []
        for x in sg["links"]:
            if x["target_id"] in reroute_ids:
                continue  # input side; covered via synthesis below
            if x["origin_id"] in reroute_ids:
                m = rin.get(x["origin_id"])
                if m is None:
                    raise ValueError(f"{where}: Reroute {x['origin_id']} "
                                     f"has no input link")
                if m["origin_id"] in reroute_ids:
                    raise ValueError(f"{where}: chained Reroutes "
                                     f"not supported")
                x = {"id": x["id"], "origin_id": m["origin_id"],
                     "origin_slot": m["origin_slot"],
                     "target_id": x["target_id"],
                     "target_slot": x["target_slot"],
                     "type": x.get("type")}
            eff_links.append(x)

        inner = [n for n in sg["nodes"] if n["type"] != "Reroute"]
        remap = {}
        for n in inner:
            remap[n["id"]] = next_nid
            next_nid += 1
        ilinks = {}
        for x in eff_links:
            if (x["origin_id"] != -10 and x["origin_id"] not in remap) \
                    or (x["target_id"] != -20 and x["target_id"] not in remap):
                raise ValueError(f"{where}: link {x['id']} touches "
                                 f"unknown node "
                                 f"{x['origin_id']}->{x['target_id']}")
            if x["id"] in ilinks:
                raise ValueError(f"{where}: duplicate link id {x['id']}")
            ilinks[x["id"]] = x
        # instance widget values <-> input defs (widget-exposed, def order).
        wvals = inst.get("widgets_values") or []
        ientries = {e.get("name"): e for e in inst.get("inputs", [])}
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
        new_by_old = {}
        for n in inner:
            c = copy.deepcopy(n)
            c["id"] = remap[n["id"]]
            new_by_old[n["id"]] = c
            flat_nodes.append(c)
            node_by_id[c["id"]] = c
        infos[inst["id"]] = {"sg": sg, "where": where, "remap": remap,
                             "new_by_old": new_by_old, "ilinks": ilinks,
                             "ientries": ientries, "defval": defval,
                             "inst": inst}

    def boundary_in(inst_id, k, depth=0):
        if depth > 16:
            raise ValueError("boundary_in: chain too deep "
                             f"(cycle near instance {inst_id})")
        info = infos[inst_id]
        d = info["sg"]["inputs"][k]
        e = info["ientries"][d["name"]]
        if e.get("link") is not None:
            return resolve_outer_origin(e["link"], depth + 1)
        if k not in info["defval"]:
            raise ValueError(f"{info['where']}: unlinked input "
                             f"{d['name']!r} has no widget value")
        return ("literal", info["defval"][k])

    def resolve_outer_origin(lid, depth=0):
        if lid not in outer_links:
            raise ValueError(f"outer link {lid} missing")
        kept_outer.add(lid)  # consumed by rewiring (incl. chain links)
        o = outer_links[lid]
        _, fr, fs, _, _, typ = o
        if fr in infos:
            return resolve_inst_output(fr, fs, depth + 1)
        return ("node", fr, fs, typ)

    def resolve_inst_output(inst_id, out_slot, depth=0):
        if depth > 16:
            raise ValueError("resolve_inst_output: chain too deep "
                             f"(cycle near instance {inst_id})")
        info = infos[inst_id]
        sg = info["sg"]
        oname = info["inst"]["outputs"][out_slot].get("name")
        k = next((i for i, d in enumerate(sg.get("outputs", []))
                  if d["name"] == oname), None)
        if k is None:
            raise ValueError(f"{info['where']}: no subgraph output "
                             f"for instance output {oname!r}")
        srcs = [x for x in info["ilinks"].values()
                if x["target_id"] == -20 and x["target_slot"] == k]
        if len(srcs) != 1:
            raise ValueError(f"{info['where']}: output {oname!r} has "
                             f"{len(srcs)} sources, expected 1")
        x = srcs[0]
        if x["origin_id"] == -10:
            return boundary_in(inst_id, x["origin_slot"], depth + 1)
        return ("node", info["remap"][x["origin_id"]],
                x["origin_slot"], x["type"])

    # ---- Phase B1: inner->inner links ------------------------------------
    for inst_id, info in infos.items():
        for lid, x in info["ilinks"].items():
            if x["target_id"] == -20:
                continue  # handled from the consumer side
            if x["origin_id"] == -10:
                origin = boundary_in(inst_id, x["origin_slot"])
            else:
                origin = ("node", info["remap"][x["origin_id"]],
                          x["origin_slot"], x["type"])
            tn = info["new_by_old"][x["target_id"]]
            tname = next((e.get("name") for e in tn.get("inputs", [])
                          if e.get("link") == lid), None)
            if tname is None:
                raise ValueError(f"{info['where']}: inner node "
                                 f"{x['target_id']} has no entry "
                                 f"for link {lid}")
            node = node_by_id[info["remap"][x["target_id"]]]
            if origin[0] == "literal":
                find_entry(node, tname)["link"] = None
                literals.append((node["id"], tname, origin[1]))
            else:
                nl = emit(origin[1], origin[2], node["id"],
                          slot_of(node, tname, lid), origin[3])
                find_entry(node, tname)["link"] = nl

    # ---- Phase B2: outer links from instances to outer nodes ------------
    # (outer->instance links were already wired in B1 via boundary_in.)
    for o in wf.get("links", []):
        lid, fr, fs, to, ts, _typ = o
        if fr not in infos or to in infos:
            continue  # copied in tail, or done in B1
        origin = resolve_outer_origin(lid)
        node = node_by_id.get(to)
        if node is None:
            raise ValueError(f"consumer node {to} missing")
        if origin[0] == "literal":
            oname = None
            for e in node.get("inputs", []):
                if e.get("link") == lid:
                    e["link"] = None
                    oname = e.get("name")
            if oname is None:
                raise ValueError(f"outer node {to} has no "
                                 f"entry for link {lid}")
            literals.append((node["id"], oname, origin[1]))
        else:
            nl = emit(origin[1], origin[2], node["id"], ts, origin[3])
            fixed = False
            for e in node.get("inputs", []):
                if e.get("link") == lid:
                    e["link"] = nl
                    fixed = True
            if not fixed:
                raise ValueError(f"outer node {to} has no entry "
                                 f"for link {lid}")

    # ---- tail: kept outer links, rebuild output lists, drop dangling -----
    for x in wf.get("links", []):
        if x[0] not in kept_outer:
            flat_links.append(list(x))
    alive = {n["id"] for n in flat_nodes}
    flat_links = [x for x in flat_links if x[1] in alive and x[3] in alive]
    for n in flat_nodes:
        for si, e in enumerate(n.get("outputs", [])):
            e["links"] = [x[0] for x in flat_links
                          if x[1] == n["id"] and x[2] == si]
        for e in n.get("inputs", []):
            if (e.get("link") is not None
                    and not any(x[0] == e["link"] for x in flat_links)):
                e["link"] = None  # dangling -> widget/default path
    return {"nodes": flat_nodes, "links": flat_links}, literals


E2B_CLIP = "gemma4_e2b_it_bf16.safetensors"


def prune_enhancer(prompt):
    """Remove the prompt-enhancer branch from a flattened 2.5 prompt.

    Template default is Enhance=false, i.e. raw prompt -> main CLIP ->
    LTXVConditioning -> guide. The enhancer nodes (e2b CLIPLoader ~10GB,
    TextGenerateLTX2Prompt x2, GemmaAPITextEncode x2 + their switches and
    helper primitives) would still EXECUTE dead branches (ComfyUI runs all
    nodes) — costing ~10GB VRAM and risking empty-api-key failures.
    Pruning reproduces the default switch selection exactly:
      9084.text <- raw prompt PrimitiveStringMultiline
      guide.positive/negative <- LTXVConditioning outputs
    Nodes are found by class+wiring (not hardcoded ids); anything left
    referencing a deleted node raises loudly. Returns pruned node count.
    """
    refs = {}  # nid -> set of (user_nid) for reverse lookup
    for nid, n in prompt.items():
        for v in n["inputs"].values():
            if isinstance(v, list):
                refs.setdefault(v[0], set()).add(nid)

    def only_users(nid, allowed):
        return refs.get(nid, set()) <= set(allowed)

    e2b = [nid for nid, n in prompt.items()
           if n["class_type"] == "CLIPLoader"
           and n["inputs"].get("clip_name") == E2B_CLIP]
    tgen = [nid for nid, n in prompt.items()
            if n["class_type"] == "TextGenerateLTX2Prompt"]
    gapi = [nid for nid, n in prompt.items()
            if n["class_type"] == "GemmaAPITextEncode"]
    switch = [nid for nid, n in prompt.items()
              if n["class_type"] == "ComfySwitchNode"]
    if len(e2b) != 1 or len(tgen) != 2 or len(gapi) != 2 or len(switch) != 4:
        raise ValueError("enhancer cluster shape changed: e2b=%s tgen=%s "
                         f"gapi={gapi} switch={switch}")
    cond = [nid for nid, n in prompt.items()
            if n["class_type"] == "LTXVConditioning"]
    enc = [nid for nid, n in prompt.items()
           if n["class_type"] == "CLIPTextEncode"]
    guide = [nid for nid, n in prompt.items()
             if n["class_type"] == "LTXAddVideoICLoRAGuideAdvanced"]
    rawstr = [nid for nid, n in prompt.items()
              if n["class_type"] == "PrimitiveStringMultiline"]
    if len(cond) != 1 or len(guide) != 1 or not enc or not rawstr:
        raise ValueError("conditioning cluster shape changed")
    c, g = cond[0], guide[0]
    # positive CLIPTextEncode = the one feeding LTXVConditioning.positive
    pos = next((nid for nid in enc
                if prompt[c]["inputs"].get("positive") == [nid, 0]), None)
    if pos is None:
        raise ValueError("no CLIPTextEncode feeds LTXVConditioning.positive")
    # raw prompt node = PrimitiveStringMultiline feeding a TextGenerate
    # (its value is the template prompt, overridden later per-run anyway).
    cand = set()
    for t in tgen:
        v = prompt[t]["inputs"].get("prompt")
        if isinstance(v, list):
            cand.add(v[0])
    cand = [nid for nid in cand if prompt[nid]["class_type"]
            == "PrimitiveStringMultiline"]
    if len(cand) != 1:
        raise ValueError(f"raw prompt node ambiguous: {cand}")
    raw = cand[0]
    # helpers: primitives consumed ONLY by deleted nodes.
    doomed = set(e2b + tgen + gapi + switch)
    helpers = [nid for nid, n in prompt.items()
               if n["class_type"] in ("PrimitiveBoolean", "StringContains",
                                      "PrimitiveString")
               and refs.get(nid, set()) and only_users(nid, doomed)]
    doomed |= set(helpers)
    # rewire raw path before deleting.
    prompt[pos]["inputs"]["text"] = [raw, 0]
    prompt[g]["inputs"]["positive"] = [c, 0]
    prompt[g]["inputs"]["negative"] = [c, 1]
    for nid in doomed:
        del prompt[nid]
    # loud check: no dangling references remain.
    for nid, n in prompt.items():
        for k, v in n["inputs"].items():
            if isinstance(v, list) and v[0] not in prompt:
                raise ValueError(f"prune left dangling ref: {nid}.{k} "
                                 f"-> {v[0]}")
    return len(doomed)


def apply_literals(prompt, literals):
    """Set boundary widget values on the converted API prompt.

    Literals targeting nodes absent from the prompt (skipped PreviewAny,
    muted nodes) are ignored with a printed note; anything else missing
    raises loudly.
    """
    n = 0
    for nid, name, value in literals:
        key = str(nid)
        if key not in prompt:
            print(f"literal: node {nid} not in prompt (skipped), "
                  f"ignoring {name!r}")
            continue
        inputs = prompt[key]["inputs"]
        if name not in inputs:
            raise ValueError(f"literal {name!r} not in node {nid} "
                             f"inputs {sorted(inputs)}")
        inputs[name] = value
        n += 1
    return n
