#!/usr/bin/env bash
# Pull Keycloak client secret from GCE VM and set Vercel production env for openhat-website.
# Does not echo secret values. Requires: gcloud, vercel CLI, openhat-www linked (.vercel/project.json).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WWW="${OPENHAT_WWW_DIR:-$ROOT/../../openhat-www}"
GCP_PROJECT="${GCP_PROJECT:-sandbox420}"
GCP_ZONE="${GCP_ZONE:-us-central1-a}"
GCP_INSTANCE="${GCP_INSTANCE:-openhat-keycloak}"

ISSUER="${KEYCLOAK_ISSUER:-https://136.71.1.161.sslip.io/realms/openhat}"
AUTH_URL="${AUTH_URL:-https://openhat-website.vercel.app}"
CLIENT_ID="${KEYCLOAK_CLIENT_ID:-openhat-portal}"

REMOTE_SCRIPT='set -euo pipefail
cd /opt/openhat/keycloak-gcp
set -a; source keycloak.env; set +a
K=/opt/keycloak/bin/kcadm.sh
docker exec openhat-keycloak $K config credentials --server http://localhost:8080 --realm master \
  --user "$KC_BOOTSTRAP_ADMIN_USERNAME" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD" >/dev/null 2>&1
CID=$(docker exec openhat-keycloak $K get clients -r openhat -q clientId=openhat-portal --fields id --format csv 2>/dev/null | tail -1 | tr -d "\"")
docker exec openhat-keycloak $K get "clients/$CID/client-secret" -r openhat --fields value --format csv 2>/dev/null | tail -1 | tr -d "\""'

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

gcloud compute ssh "$GCP_INSTANCE" --zone="$GCP_ZONE" --project="$GCP_PROJECT" \
  --command="sudo bash -c $(printf '%q' "$REMOTE_SCRIPT")" 2>/dev/null > "$TMP"

KC_SECRET="$(grep -E '^[A-Za-z0-9_-]{16,}$' "$TMP" | tail -1 || true)"
if [[ -z "$KC_SECRET" ]]; then
  KC_SECRET="$(tail -1 "$TMP" | tr -d '[:space:]')"
fi
if [[ ${#KC_SECRET} -lt 8 ]]; then
  echo "failed to read client secret from VM" >&2
  exit 1
fi

AUTH_SECRET="$(openssl rand -base64 32)"
cd "$WWW"

set_vercel() {
  local name="$1"
  local val="$2"
  vercel env rm "$name" production -y 2>/dev/null || true
  printf '%s' "$val" | vercel env add "$name" production --force
}

set_vercel AUTH_SECRET "$AUTH_SECRET"
set_vercel AUTH_URL "$AUTH_URL"
set_vercel NEXTAUTH_URL "$AUTH_URL"
set_vercel KEYCLOAK_ISSUER "$ISSUER"
set_vercel KEYCLOAK_CLIENT_ID "$CLIENT_ID"
set_vercel KEYCLOAK_CLIENT_SECRET "$KC_SECRET"
set_vercel AUTH_TRUST_HOST true

echo "ok: Vercel production env updated for openhat-website (6 vars)"
