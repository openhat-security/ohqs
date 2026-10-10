#!/usr/bin/env bash
# Forward a local port to Keycloak on the GCE VM (not local Docker).
#
# GCP Keycloak is hostname-strict on https://<KEYCLOAK_PUBLIC_HOST>.
# The portal should keep KEYCLOAK_ISSUER at that HTTPS URL.
# This tunnel is for hitting the VM's Keycloak HTTP from this machine
# without starting docker/docker-compose Keycloak locally.
#
# Usage:
#   ./scripts/keycloak-tunnel.sh          # default local 18080 (8080 is often taken)
#   ./scripts/keycloak-tunnel.sh --stop
#   LOCAL_PORT=18080 ./scripts/keycloak-tunnel.sh

set -euo pipefail

GCP_PROJECT="${GCP_PROJECT:-sandbox420}"
GCP_ZONE="${GCP_ZONE:-us-central1-a}"
GCP_INSTANCE="${GCP_INSTANCE:-openhat-keycloak}"
# 8080 is often another local API. 18080 may already be a different GCE tunnel.
LOCAL_PORT="${LOCAL_PORT:-18090}"
PID_FILE="${TMPDIR:-/tmp}/openhat-keycloak-tunnel-${LOCAL_PORT}.pid"
LOG_FILE="${TMPDIR:-/tmp}/openhat-keycloak-tunnel-${LOCAL_PORT}.log"

stop_tunnel() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "${pid}" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 0.3
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi
  # Also drop a leftover ssh with this local forward.
  local extra
  extra="$(lsof -nP -iTCP:"$LOCAL_PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
  if [[ -n "$extra" ]]; then
    local p args
    for p in $extra; do
      args="$(ps -p "$p" -o args= 2>/dev/null || true)"
      if [[ "$args" == *openhat-keycloak* ]] || [[ "$args" == *" -L ${LOCAL_PORT}:"* ]]; then
        kill "$p" 2>/dev/null || true
      fi
    done
  fi
  echo "stopped tunnel on 127.0.0.1:${LOCAL_PORT}"
}

if [[ "${1:-}" == "--stop" ]]; then
  stop_tunnel
  exit 0
fi

if lsof -nP -iTCP:"$LOCAL_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "already forwarding 127.0.0.1:${LOCAL_PORT} -> ${GCP_INSTANCE}"
    exit 0
  fi
  echo "port ${LOCAL_PORT} is in use; set LOCAL_PORT= or stop the other listener" >&2
  lsof -nP -iTCP:"$LOCAL_PORT" -sTCP:LISTEN >&2 || true
  exit 1
fi

echo "== resolving Keycloak container on ${GCP_INSTANCE}"
KC_IP="$(gcloud compute ssh "$GCP_INSTANCE" --zone="$GCP_ZONE" --project="$GCP_PROJECT" \
  --command='sudo docker inspect -f "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}" openhat-keycloak')"
KC_IP="$(printf '%s' "$KC_IP" | tr -d '[:space:]')"
if [[ ! "$KC_IP" =~ ^[0-9.]+$ ]]; then
  echo "could not get openhat-keycloak container IP" >&2
  exit 1
fi

echo "== SSH -L ${LOCAL_PORT}:${KC_IP}:8080 (${GCP_INSTANCE})"
# Destination is evaluated on the VM. Do not start local Docker.
# nohup/disown so the forward survives this script exiting.
nohup gcloud compute ssh "$GCP_INSTANCE" --zone="$GCP_ZONE" --project="$GCP_PROJECT" \
  -- -N -o ExitOnForwardFailure=yes -L "${LOCAL_PORT}:${KC_IP}:8080" \
  >"$LOG_FILE" 2>&1 &
echo $! >"$PID_FILE"
disown $! 2>/dev/null || true

ok=false
for i in $(seq 1 20); do
  if curl -sf --max-time 2 "http://127.0.0.1:${LOCAL_PORT}/realms/openhat" >/dev/null 2>&1; then
    ok=true
    break
  fi
  sleep 0.5
done

if [[ "$ok" != true ]]; then
  echo "tunnel up but /realms/openhat not ready yet — see $LOG_FILE" >&2
  echo "portal OIDC still uses https://136.71.1.161.sslip.io/realms/openhat (GCP hostname-strict)"
  exit 0
fi

echo "ok: http://127.0.0.1:${LOCAL_PORT}/realms/openhat  (VM Keycloak HTTP)"
echo "portal OIDC issuer remains https://136.71.1.161.sslip.io/realms/openhat"
echo "stop: $0 --stop"
