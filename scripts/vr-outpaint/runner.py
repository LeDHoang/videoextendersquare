"""Run each prompt in a fresh ComfyUI process; log peak VRAM, RAM and wall time per run."""
import json, os, signal, subprocess, sys, time, urllib.request as u

ROOT = "/opt/comfyui-baked"
RES = "/workspace/results"
URL = "http://127.0.0.1:8189"
os.makedirs(RES, exist_ok=True)


def get(path):
    return json.load(u.urlopen(URL + path, timeout=10))


def cg(name):
    try:
        return int(open(f"/sys/fs/cgroup/{name}").read().split()[0])
    except Exception:
        return None


def status_kb(pid, key):
    try:
        for line in open(f"/proc/{pid}/status"):
            if line.startswith(key):
                return int(line.split()[1])
    except Exception:
        return None


for name in sys.argv[1:]:
    prompt = json.load(open(f"/root/prompts/{name}.json"))
    summ = {"run": name}
    log = open(f"{RES}/{name}.comfy.log", "w")
    proc = subprocess.Popen(["python3.12", "main.py", "--listen", "127.0.0.1", "--port", "8189",
                             "--use-sage-attention"], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
    for _ in range(180):
        try:
            get("/object_info/KSamplerSelect"); break
        except Exception:
            time.sleep(1)
    try:
        open("/sys/fs/cgroup/memory.peak", "w").write("0")
        summ["cgroup_peak_reset"] = True
    except Exception as e:
        summ["cgroup_peak_reset"] = repr(e)
    smi = subprocess.Popen(["nvidia-smi", "--query-gpu=timestamp,memory.used,utilization.gpu",
                            "--format=csv,noheader,nounits", "-lms", "1000"],
                           stdout=open(f"{RES}/{name}.vram.csv", "w"))
    rss_log = open(f"{RES}/{name}.ram.csv", "w")
    t0 = time.time()
    req = u.Request(URL + "/prompt", data=json.dumps({"prompt": prompt}).encode(),
                    headers={"Content-Type": "application/json"})
    try:
        pid = json.load(u.urlopen(req))["prompt_id"]
    except u.HTTPError as e:
        summ["submit_error"] = e.read().decode()[:4000]
        pid = None
    hist = None
    while pid and time.time() - t0 < 3600:
        rss_log.write(f"{time.time()-t0:.1f},{status_kb(proc.pid,'VmRSS:')},{cg('memory.current')}\n"); rss_log.flush()
        try:
            h = get(f"/history/{pid}")
            if pid in h and h[pid].get("status", {}).get("completed") is not None and \
                    h[pid]["status"].get("status_str") in ("success", "error"):
                hist = h[pid]; break
        except Exception:
            pass
        time.sleep(1)
    summ["wall_s"] = round(time.time() - t0, 1)
    summ["vmhwm_gb"] = round((status_kb(proc.pid, "VmHWM:") or 0) / 1048576, 2)
    summ["cgroup_peak_gb"] = round((cg("memory.peak") or 0) / 1073741824, 2)
    smi.terminate()
    vram = [int(l.split(",")[1]) for l in open(f"{RES}/{name}.vram.csv") if l.count(",") >= 2]
    summ["vram_peak_gb"] = round(max(vram) / 1024, 2) if vram else None
    if hist:
        summ["status"] = hist["status"].get("status_str")
        summ["messages"] = [m for m in hist["status"].get("messages", []) if m[0] == "execution_error"]
        files = []
        for out in hist.get("outputs", {}).values():
            for g in out.get("gifs", []):
                files.append(g.get("fullpath") or os.path.join(ROOT, "output", g.get("subfolder", ""), g["filename"]))
        summ["files"] = files
    else:
        summ["status"] = summ.get("status", "timeout_or_submit_error")
    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(30)
    except Exception:
        proc.kill(); proc.wait()
    json.dump(summ, open(f"{RES}/{name}.summary.json", "w"), indent=1)
    print(json.dumps(summ), flush=True)
print("RUNNER_DONE", flush=True)
