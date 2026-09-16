#!/usr/bin/env bash
set -euo pipefail

regular_root=/mnt/r5300-bulk/GRINVIRO_CORPORATE_WORKPLANE/12_AI_MODEL_AND_MEDIA_VAULT/models/.staging/DeepSeek-V4-Flash-Vision-Exp__unsloth__UD-Q8_K_XL__b977d3c0ea2da58dbc12ddae8fb8951a7b3854d0
root=/mnt/r5300-bulk/GRINVIRO_CORPORATE_WORKPLANE/12_AI_MODEL_AND_MEDIA_VAULT/models/.staging/.derived-staging/DeepSeek-V4-Flash-Vision-Uncensored-Derived-Q8_0-BF16-MMProj-R3__orcarouter__2ef3d5c2bb7d9ccba6ab66314ed9e63bd52ac2a6
server="$regular_root/runtime/glm5next-pr27754-629b50552801912b3e2078f9799e4d77213197d7-r2/build-cuda-sm89/bin/llama-server"
model="$root/deepseek-v4-flash-vision-uncensored-mxfp4_moe-00001-of-00004.gguf"
projector="$root/mmproj-deepseek-v4-flash-vision-uncensored-bf16.gguf"

verify_hash() {
  local path=$1 expected=$2 actual
  actual=$(sha256sum "$path" | awk '{print $1}')
  [ "$actual" = "$expected" ]
}

verify_hash "$server" 85e4a3da80b7ee814fd94f7f3982e0b36cca177ead2d69596aef804efb1a09c4
verify_hash "$root/.evidence/RUNTIME_PREFLIGHT_DEEPSEEK_V4_FLASH_VISION_UNCENSORED_R1_20260907.json" 3d989e2580b5ef96c60f45dba34c73d1d9bb3d16e39e60556e2e99c70d41cf40
[ -r "$model" ]
[ -r "$projector" ]
[ "${GCP_LAUNCHER_VERIFY_ONLY:-0}" != 1 ] || { printf 'GCP_LAUNCHER_VERIFIED deepseek-v4-flash-vision-uncensored\n'; exit 0; }

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
  --port 18084 \
  --alias deepseek-v4-flash-vision-uncensored-derived-q8-0
