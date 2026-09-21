#!/usr/bin/env bash
set -euo pipefail
port=8787
pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)"
[[ -n "$pids" ]] || { echo "ohqs: nothing listening on ${port}"; exit 0; }
for pid in $pids; do
  args="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  if [[ "$args" == *ohqs* ]]; then
    kill "$pid" 2>/dev/null || true
    echo "ohqs: stopped pid ${pid}"
  else
    echo "ohqs: port ${port} is in use by something else: ${args:-pid $pid}" >&2
    exit 1
  fi
done
