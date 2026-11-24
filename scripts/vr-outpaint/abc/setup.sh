#!/bin/sh
M=/opt/comfyui-baked/models
H=https://huggingface.co
dl() { curl -sSL --retry 5 -o "$1" "$2" && echo "OK $1" || echo "FAIL $1"; }
mkdir -p $M/loras/ltx-2
dl $M/diffusion_models/ltx-2.3-22b-distilled-1.1_transformer_only_mxfp8_block32.safetensors $H/Kijai/LTX2.3_comfy/resolve/main/diffusion_models/ltx-2.3-22b-distilled-1.1_transformer_only_mxfp8_block32.safetensors > /tmp/dl1.log 2>&1 &
dl $M/text_encoders/gemma_3_12B_it.safetensors $H/Comfy-Org/ltx-2/resolve/main/split_files/text_encoders/gemma_3_12B_it.safetensors > /tmp/dl2.log 2>&1 &
( dl $M/text_encoders/ltx-2.3_text_projection_bf16.safetensors $H/Kijai/LTX2.3_comfy/resolve/main/text_encoders/ltx-2.3_text_projection_bf16.safetensors
  dl $M/loras/ltx-2/360vroutpaint_v2_step07000.safetensors $H/TheBurgstall/VR-360-Outpaint-LTX2.3-IC-LoRA/resolve/main/360vroutpaint_v2_step07000.safetensors
  dl $M/vae/LTX23_video_vae_bf16.safetensors $H/Kijai/LTX2.3_comfy/resolve/main/vae/LTX23_video_vae_bf16.safetensors
  dl $M/vae/LTX23_audio_vae_bf16.safetensors $H/Kijai/LTX2.3_comfy/resolve/main/vae/LTX23_audio_vae_bf16.safetensors ) > /tmp/dl3.log 2>&1 &
cd /opt/comfyui-baked/custom_nodes
( for r in Burgstall-labs/ComfyUI-VR-Outpaint-Tools Burgstall-labs/ComfyUI-Seamless-Equirectangular Lightricks/ComfyUI-LTXVideo Kosinkadink/ComfyUI-VideoHelperSuite; do git clone --depth 1 https://github.com/$r.git; done
  for d in ComfyUI-VR-Outpaint-Tools ComfyUI-Seamless-Equirectangular ComfyUI-LTXVideo ComfyUI-VideoHelperSuite ComfyUI-KJNodes; do
    [ -f $d/requirements.txt ] && python3.12 -m pip install -q -c /opt/comfyui-runtime-constraints.txt -r $d/requirements.txt && echo "PIP OK $d" || echo "PIP FAIL $d"; done
  echo SETUP_DONE ) > /tmp/setup.log 2>&1 &
wait
echo ALL_DONE >> /tmp/setup.log
