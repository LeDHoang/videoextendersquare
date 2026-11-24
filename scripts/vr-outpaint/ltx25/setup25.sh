#!/bin/sh
# LTX-2.5 + LTX-2.3 stack for the native-4K method-A tests. Token is read from /root/.hf_token.
M=/opt/comfyui-baked/models
H=https://huggingface.co
PY=python3.12
export HF_TOKEN="$(cat /root/.hf_token)"
export HF_XET_HIGH_PERFORMANCE=1
unset HF_HUB_ENABLE_HF_TRANSFER
mkdir -p $M/loras/ltx-2 $M/latent_upscale_models /tmp/logs
$PY -m pip install -q -U "huggingface_hub[hf_xet]" > /tmp/logs/pip_hf.log 2>&1
hfd() { repo=$1; dir=$2; shift 2; $PY -c "
import sys
from huggingface_hub import hf_hub_download
repo, d = sys.argv[1], sys.argv[2]
for f in sys.argv[3:]:
    p = hf_hub_download(repo, f, local_dir=d)
    print('OK', p, flush=True)
" "$repo" "$dir" "$@" || echo "FAIL $repo $*"; }
# gated LTX-2.5 (repo layout matches ComfyUI model folders)
hfd Lightricks/LTX-2.5 $M diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors > /tmp/logs/dl_unet25.log 2>&1 &
hfd Lightricks/LTX-2.5 $M text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors > /tmp/logs/dl_te25.log 2>&1 &
( hfd Lightricks/LTX-2.5 $M vae/ltx-2.5-video-vae-bf16.safetensors vae/ltx-2.5-audio-vae-bf16.safetensors latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors
  hfd Lightricks/LTX-2.5-22b-IC-LoRA-Pixel-Spatial-Upscaler $M/loras/ltx-2 ltx-2.5-22b-ic-lora-pixel-spatial-upscaler-x2-1.0.safetensors
  hfd Lightricks/LTX-2.5-22b-IC-LoRA-Refine-Details $M/loras/ltx-2 ltx-2.5-22b-ic-lora-refine-details-1.0.safetensors
  hfd Lightricks/LTX-2.3 $M/latent_upscale_models ltx-2.3-spatial-upscaler-x2-1.1.safetensors ) > /tmp/logs/dl_small25.log 2>&1 &
# LTX-2.3 method-A stack (same as the 2026-11-24 runs)
hfd Kijai/LTX2.3_comfy /tmp/kj diffusion_models/ltx-2.3-22b-distilled-1.1_transformer_only_mxfp8_block32.safetensors > /tmp/logs/dl_unet23.log 2>&1 &
hfd Comfy-Org/ltx-2 /tmp/co split_files/text_encoders/gemma_3_12B_it.safetensors > /tmp/logs/dl_te23.log 2>&1 &
( hfd Kijai/LTX2.3_comfy /tmp/kj text_encoders/ltx-2.3_text_projection_bf16.safetensors vae/LTX23_video_vae_bf16.safetensors vae/LTX23_audio_vae_bf16.safetensors
  hfd TheBurgstall/VR-360-Outpaint-LTX2.3-IC-LoRA $M/loras/ltx-2 360vroutpaint_v2_step07000.safetensors ) > /tmp/logs/dl_small23.log 2>&1 &
# custom nodes, latest
cd /opt/comfyui-baked/custom_nodes
( for r in Burgstall-labs/ComfyUI-VR-Outpaint-Tools Burgstall-labs/ComfyUI-Seamless-Equirectangular Lightricks/ComfyUI-LTXVideo Kosinkadink/ComfyUI-VideoHelperSuite; do
    d=$(basename $r); [ -d $d ] && git -C $d pull -q || git clone -q --depth 1 https://github.com/$r.git; echo "NODE $d $(git -C $d log -1 --format=%h)"; done
  for d in ComfyUI-VR-Outpaint-Tools ComfyUI-Seamless-Equirectangular ComfyUI-LTXVideo ComfyUI-VideoHelperSuite ComfyUI-KJNodes; do
    [ -f $d/requirements.txt ] && $PY -m pip install -q -c /opt/comfyui-runtime-constraints.txt -r $d/requirements.txt && echo "PIP OK $d" || echo "PIP FAIL $d"; done
  $PY -m pip install -q 'geocalib @ git+https://github.com/cvg/GeoCalib' && echo "PIP OK geocalib" || echo "PIP FAIL geocalib"
  echo NODES_DONE ) > /tmp/logs/nodes.log 2>&1 &
wait
# move the 2.3 files into ComfyUI folders
mv /tmp/kj/diffusion_models/* $M/diffusion_models/ 2>/dev/null
mv /tmp/kj/text_encoders/* /tmp/co/split_files/text_encoders/* $M/text_encoders/ 2>/dev/null
mv /tmp/kj/vae/* $M/vae/ 2>/dev/null
ls -la $M/diffusion_models $M/text_encoders $M/vae $M/loras/ltx-2 $M/latent_upscale_models > /tmp/logs/models.txt
echo ALL_DONE >> /tmp/logs/nodes.log
