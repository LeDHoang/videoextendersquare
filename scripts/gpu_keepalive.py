import os
import signal
import time

import torch


running = True


def stop(_signum, _frame):
    global running
    running = False


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)

device = torch.device("cuda:0")
a = torch.randn((2048, 2048), device=device)
b = torch.randn((2048, 2048), device=device)

print(f"GPU keepalive started (pid={os.getpid()}, device={torch.cuda.get_device_name(0)})", flush=True)
while running:
    burst_end = time.monotonic() + 0.25
    while running and time.monotonic() < burst_end:
        torch.mm(a, b)
    torch.cuda.synchronize()
    time.sleep(0.75)

print("GPU keepalive stopped", flush=True)
