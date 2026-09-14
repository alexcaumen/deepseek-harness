#!/usr/bin/env bash
set -euo pipefail

root=/opt/gcp-prdg
python=${root}/venv311/bin/python
model=${root}/models/Qwen3.8-27B
state=${root}/state
pid_file=${state}/qwen38.pid
log_file=${state}/qwen38.log
marker=GCP_PRDG_QWEN38_R2
manifest_sha256=961f81d06097db0c87867559913adab5bf6692998b7af423cea859867b30c7b2
model_commit=1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0

test -x "${python}"
"${python}" - "${model}" "${manifest_sha256}" "${model_commit}" <<'PY'
import hashlib
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1]).resolve(strict=True)
manifest_path = root / "acquisition_manifest.json"
manifest_bytes = manifest_path.read_bytes()
if hashlib.sha256(manifest_bytes).hexdigest() != sys.argv[2]:
    raise SystemExit(76)
manifest = json.loads(manifest_bytes)
files = manifest.get("files")
if (manifest.get("repo") != "Qwen/Qwen3.8-27B"
        or manifest.get("commit") != sys.argv[3]
        or not isinstance(files, list)
        or manifest.get("file_count") != len(files)):
    raise SystemExit(76)
total = 0
for entry in files:
    relative = pathlib.PurePosixPath(entry["path"])
    if relative.is_absolute() or ".." in relative.parts:
        raise SystemExit(76)
    path = root.joinpath(*relative.parts).resolve(strict=True)
    if root not in path.parents or not path.is_file() or path.stat().st_size != entry["bytes"]:
        raise SystemExit(76)
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != entry["sha256"]:
        raise SystemExit(76)
    total += entry["bytes"]
if total != manifest.get("expected_total_bytes") or total != manifest.get("verified_total_bytes"):
    raise SystemExit(76)
PY
install -d -m 700 "${state}"
if [[ -e "${pid_file}" ]]; then
  read -r existing < "${pid_file}" || exit 76
  if [[ "${existing}" =~ ^[1-9][0-9]*$ ]] && kill -0 "${existing}" 2>/dev/null; then
    exit 76
  fi
  rm -f -- "${pid_file}"
fi

umask 077
: > "${log_file}"
command=(
  "${python}" -m vllm.entrypoints.openai.api_server
  --model "${model}"
  --host 127.0.0.1
  --port 18472
  --dtype bfloat16
  --max-model-len 32768
  --quantization fp8
  --enforce-eager
  --served-model-name Qwen/Qwen3.8-27B
  --gpu-memory-utilization 0.82
  --max-num-seqs 1
  --enable-auto-tool-choice
  --tool-call-parser qwen3_xml
  --reasoning-parser qwen3
)
nohup setsid env GCP_PROCESS_MARKER="${marker}" VLLM_USE_V2_MODEL_RUNNER=0 \
  VLLM_USE_FLASHINFER_SAMPLER=0 "${command[@]}" \
  8>&- 9>&- >>"${log_file}" 2>&1 </dev/null &
pid=$!
printf '%s\n' "${pid}" > "${pid_file}"
for _ in {1..100}; do
  if ! kill -0 "${pid}" 2>/dev/null; then
    rm -f -- "${pid_file}"
    exit 76
  fi
  if [[ -r "/proc/${pid}/environ" ]] \
    && tr '\000' '\n' < "/proc/${pid}/environ" | grep -Fqx -- "GCP_PROCESS_MARKER=${marker}"; then
    exit 0
  fi
  sleep 0.1
done
exit 76
