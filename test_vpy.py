import vapoursynth as vs
import os

core = vs.core
core.std.LoadPlugin('/opt/homebrew/lib/vapoursynth/vsznedi3.so')

input_dir = "/Users/hoangleduc/Documents/[ez]/Coding/VR Tiktok/videoextendersquare/input"
files = [f for f in os.listdir(input_dir) if f.lower().endswith(".mp4") and not f.endswith("_fast.mp4") and not f.endswith("_studio.mp4")]
video_path = os.path.join(input_dir, files[0])

clip = core.ffms2.Source(video_path)
clip = core.znedi3.nnedi3(clip, field=1, dh=True, nsize=0, nns=3, qual=2, pscrn=2)
clip = core.resize.Spline36(clip, width=3840, height=3840)
clip.set_output()
