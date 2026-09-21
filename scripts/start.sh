#!/usr/bin/env bash
# Build is the caller's job. This frees 127.0.0.1:8787 if our old ohqs
# is there, then starts the UI. One process: HTML + JSON + catalog index.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
bin="$root/bin/ohqs"
host=127.0.0.1
port=8787
url="http://${host}:${port}"

die() { echo "ohqs: $*" >&2; exit 1; }

[[ -x "$bin" ]] || die "missing $bin (run: make build)"
[[ -f "$root/data/ohqs.sqlite" ]] || "$bin" index
"$bin" install-cli
export PATH="$root/bin:$root/bin/tools:$PATH"

listen_pids() {
  lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true
}

is_ohqs() {
  local args
  args="$(ps -p "$1" -o args= 2>/dev/null || true)"
  [[ "$args" == *ohqs* ]]
}

stop_ours() {
  local pid
  for pid in $(listen_pids); do
    if is_ohqs "$pid"; then
      kill "$pid" 2>/dev/null || true
    else
      local who
      who="$(ps -p "$pid" -o args= 2>/dev/null || echo "pid $pid")"
      die "port ${port} is in use by something else: ${who}"
    fi
  done
  local i
  for i in $(seq 1 30); do
    [[ -z "$(listen_pids)" ]] && return 0
    sleep 0.1
  done
  for pid in $(listen_pids); do
    is_ohqs "$pid" && kill -9 "$pid" 2>/dev/null || true
  done
  [[ -z "$(listen_pids)" ]] || die "could not free port ${port}"
}

stop_ours

echo "ohqs  ${url}"
if [[ "$(uname -s)" == Darwin ]] && command -v open >/dev/null; then
  open "$url" >/dev/null 2>&1 || true
fi
exec "$bin" serve
