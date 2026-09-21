#!/usr/bin/env bash
#
# Embed the contract rows' vectors at the edge in small chunks. Each Worker
# invocation is limited to ~50 D1 subrequests, so we step through records in
# batches of 32 (kind=contract keeps it to the ~940 contract rows).
#
# Usage (maintainer; ADMIN_TOKEN in deploy/worker/.admin_token.txt):
#   ./embed-edge.sh                          # all kinds, every 32 rows
#   ./embed-edge.sh contract                 # only kind=contract
#   ADMIN_TOKEN=… ./embed-edge.sh contract
set -euo pipefail
cd "$(dirname "$0")"

API="${API_BASE:-https://ohqs.ukryty.workers.dev}"
TOKEN="${ADMIN_TOKEN:-$(cat ../../deploy/worker/.admin_token.txt 2>/dev/null || echo '')}"
KIND="${1:-}"
[ -n "$TOKEN" ] || { echo "ADMIN_TOKEN required" >&2; exit 1; }

offset=0; step=32; total=0
while :; do
  out="$(curl -s -X POST -H "Authorization: Bearer $TOKEN" "$API/v1/index/embed?offset=$offset&count=$step${KIND:+&kind=$KIND}")"
  embedded="$(echo "$out" | sed -n 's/.*"embedded"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p')"
  retry="$(echo "$out" | sed -n 's/.*"retry_after_seconds"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p')"
  if [ -n "$retry" ] && [ "$retry" != "0" ]; then
    echo "offset $offset -> rate limited; sleeping $retry s"
    sleep "$retry"; continue
  fi
  if [ -z "$embedded" ] || [ "$embedded" = "0" ]; then
    echo "($offset) done — $(echo "$out" | head -c 200)"
    break
  fi
  total=$((total + embedded))
  echo "offset $offset -> embedded $embedded (cumulative $total)"
  offset=$((offset + step))
  sleep 1
done
echo "total embedded: $total"