#!/usr/bin/env bash
set -euo pipefail

root=/mnt/r5300-bulk/GRINVIRO_CORPORATE_WORKPLANE/12_AI_MODEL_AND_MEDIA_VAULT/models/.staging/DeepSeek-V4-Flash-Vision-Exp__unsloth__UD-Q8_K_XL__b977d3c0ea2da58dbc12ddae8fb8951a7b3854d0
server="$root/runtime/build-cuda-sm89-r2/bin/llama-server"
model="$root/payload/UD-Q8_K_XL/DeepSeek-V4-Flash-Vision-Exp-UD-Q8_K_XL-00001-of-00005.gguf"
projector="$root/payload/mmproj-BF16.gguf"

verify_hash() {
  local path=$1 expected=$2 actual
  actual=$(sha256sum "$path" | awk '{print $1}')
  [ "$actual" = "$expected" ]
}

verify_hash "$server" 1374dbed921ed443c26cfd541b5c00d0d53e50ff17a07fefb8f742c05847a00e
verify_hash "$root/evidence/manifest.json" df9e3f574494e0192a8a44e4c07026f7c3c0448b403576365542f85dfe3e28b0
verify_hash "$model" 1f2eb50c87f116e0dfe0d865b3afa193564156dc25f9b27e294bde0602ec5546
[ -r "$projector" ]
[ "${GCP_LAUNCHER_VERIFY_ONLY:-0}" != 1 ] || { printf 'GCP_LAUNCHER_VERIFIED deepseek-v4-flash-vision-regular\n'; exit 0; }

export CUDA_VISIBLE_DEVICES=0,1
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1

exec "$server" \
  --model "$model" \
  --mmproj "$projector" \
  --gpu-layers 20 \
  --split-mode layer \
  --tensor-split 0.85,1.15 \
  --ctx-size 8192 \
  --parallel 2 \
  --flash-attn on \
  --offline \
  --metrics \
  --slots \
  --host 127.0.0.1 \
  --port 18083 \
  --alias deepseek-v4-flash-vision-exp-unsloth-ud-q8-k-xl
