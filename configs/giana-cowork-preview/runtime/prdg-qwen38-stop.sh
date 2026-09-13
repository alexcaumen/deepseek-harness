#!/usr/bin/env bash
set -euo pipefail

pid_file=/opt/gcp-prdg/state/qwen38.pid
marker=GCP_PRDG_QWEN38_R2
test -r "${pid_file}"
read -r pid < "${pid_file}"
[[ "${pid}" =~ ^[1-9][0-9]*$ ]]
test -r "/proc/${pid}/environ"
tr '\000' '\n' < "/proc/${pid}/environ" | grep -Fqx -- "GCP_PROCESS_MARKER=${marker}"
pgid=$(ps -o pgid= -p "${pid}" | tr -d ' ')
[[ "${pgid}" =~ ^[1-9][0-9]*$ ]]

pgid_has_live_process() {
  local snapshot
  if ! snapshot=$(ps -eo pgid=,stat=); then
    exit 76
  fi
  awk -v target="${pgid}" '
    $1 == target && $2 !~ /^Z/ { found = 1; exit }
    END { exit(found ? 0 : 1) }
  ' <<< "${snapshot}"
}

remove_pid_handle_if_stopped() {
  if pgid_has_live_process; then
    return 1
  fi
  rm -f -- "${pid_file}"
}

kill -TERM -- "-${pgid}"
for _ in {1..60}; do
  if remove_pid_handle_if_stopped; then
    exit 0
  fi
  sleep 1
done
kill -KILL -- "-${pgid}"
for _ in {1..10}; do
  if remove_pid_handle_if_stopped; then
    exit 0
  fi
  sleep 1
done
exit 76
