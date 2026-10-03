#!/usr/bin/env bash
# Set KEYCLOAK_ISSUER on the production Cloudflare Worker (requires CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ISSUER="${KEYCLOAK_ISSUER:-https://136.71.1.161.sslip.io/realms/openhat}"

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "CLOUDFLARE_API_TOKEN is required" >&2
  exit 1
fi
if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  echo "CLOUDFLARE_ACCOUNT_ID is required" >&2
  exit 1
fi

cd "$ROOT/deploy/worker"
printf '%s' "$ISSUER" | npx wrangler secret put KEYCLOAK_ISSUER
echo "ok: Worker KEYCLOAK_ISSUER set"
