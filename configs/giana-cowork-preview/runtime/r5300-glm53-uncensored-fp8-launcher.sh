#!/usr/bin/env bash
set -euo pipefail

root=/mnt/r5300-bulk/GRINVIRO_CORPORATE_WORKPLANE/12_AI_MODEL_AND_MEDIA_VAULT/models/.staging/GLM-5.3-Flash-Uncensored-FP8__orcarouter__3cec42d6ed14ec197e328c09650c17fd3660c26a
runtime=/mnt/r5300-bulk/GRINVIRO_CORPORATE_WORKPLANE/12_AI_MODEL_AND_MEDIA_VAULT/models/.staging/GLM-5.3-Flash__zai-org__03eb5366286afd40d2221b1d9c63a6dd1ba4832e/runtime
python="$runtime/py311/bin/python"

verify_hash() {
  local path=$1 expected=$2 actual
  actual=$(sha256sum "$path" | awk '{print $1}')
  [ "$actual" = "$expected" ]
}

verify_hash "$python" 6ff97f602038740073dca96714310a30e303332326268e0f1bb2767edc820944
verify_hash "$root/config.json" bb8f01c42cb92a52ca72e65afb4d5bd8d11aef083cd210e8de25dfb904f23e9f
verify_hash "$root/model.safetensors.index.json" 3c3f40366a53c3fd7974b4eab7881a365a98c2a4329150befebab99fe7c18b05
[ "${GCP_LAUNCHER_VERIFY_ONLY:-0}" != 1 ] || { printf 'GCP_LAUNCHER_VERIFIED glm53-uncensored-fp8\n'; exit 0; }

export CC="$runtime/cuda-12.8.93/bin/x86_64-conda-linux-gnu-cc"
export CUDA_HOME="$runtime/cuda-12.8-view"
export CUDA_VISIBLE_DEVICES=1
export CXX="$runtime/cuda-12.8.93/bin/x86_64-conda-linux-gnu-c++"
export FLASHINFER_WORKSPACE_BASE="$runtime/canary/flashinfer-workspace-cu128-gpu1"
export HF_HUB_OFFLINE=1
export HOME="$runtime/canary/home"
export LD_LIBRARY_PATH="$runtime/cuda-12.8-view/lib64:$runtime/py311/lib/python3.11/site-packages/nvidia/cublas/lib:$runtime/py311/lib/python3.11/site-packages/nvidia/cuda_runtime/lib"
export PATH="$runtime/py311/bin:$runtime/cuda-12.8-view/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export PYTHONNOUSERSITE=1
export PYTHONUNBUFFERED=1
export SGLANG_APPLY_CONFIG_BACKUP=none
export SGLANG_NSA_FUSE_TOPK=0
export SGL_KERNEL_TOPK_TORCH_FALLBACK=1
export TOKENIZERS_PARALLELISM=false
export TORCH_EXTENSIONS_DIR="$runtime/canary/torch-extensions-cu128-gpu1"
export TRANSFORMERS_OFFLINE=1
export TVM_FFI_CACHE_DIR="$runtime/canary/tvm-ffi-cache-cu128-gpu1"
export XDG_CACHE_HOME="$runtime/canary/xdg-cache"

exec "$python" -m sglang.launch_server \
  --model-path "$root" \
  --kt-weight-path "$root" \
  --served-model-name glm-5.3-flash-uncensored-fp8 \
  --host 127.0.0.1 \
  --port 18085 \
  --tp-size 1 \
  --context-length 4096 \
  --mem-fraction-static 0.65 \
  --chunked-prefill-size 2048 \
  --kt-method FP8 \
  --kt-cpuinfer 64 \
  --kt-threadpool-count 2 \
  --kt-num-gpu-experts 0 \
  --kt-gpu-prefill-token-threshold 2048 \
  --cuda-graph-bs 1 \
  --limit-mm-data-per-request '{"image":1}' \
  --mm-process-config '{"image":{"max_pixels":1254400}}' \
  --tool-call-parser glm47 \
  --reasoning-parser glm45
