#!/usr/bin/env bash
# Verify local or env-provided Cloudflare creds match what GitHub Actions needs.
# Usage:
#   export CLOUDFLARE_API_TOKEN=...
#   export CLOUDFLARE_ACCOUNT_ID=...
#   ./scripts/verify-cloudflare-deploy.sh
#
# Or paste when prompted (not echoed). Then update GitHub:
#   gh secret set CLOUDFLARE_API_TOKEN --repo openhat-security/ohqs
#   gh secret set CLOUDFLARE_ACCOUNT_ID --repo openhat-security/ohqs

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="${GITHUB_REPOSITORY:-openhat-security/ohqs}"
# Worker + D1 "ohqs" in wrangler.toml (prod today)
EXPECTED_ACCOUNT_ID="${OHQS_CF_ACCOUNT_ID:-0e2e76e6a07a520ca302a94076f16139}"
EXPECTED_ACCOUNT_NAME="Devrecated Solutions"

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  read -r -s -p "CLOUDFLARE_API_TOKEN: " CLOUDFLARE_API_TOKEN
  echo
fi
# Trim whitespace / accidental paste newlines
CLOUDFLARE_API_TOKEN="$(printf '%s' "$CLOUDFLARE_API_TOKEN" | tr -d '\r\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
export CLOUDFLARE_API_TOKEN

if [[ -z "$CLOUDFLARE_API_TOKEN" ]]; then
  echo "error: empty CLOUDFLARE_API_TOKEN (paste the secret shown once at token creation, not the policy JSON)" >&2
  exit 1
fi

echo "== token (length ${#CLOUDFLARE_API_TOKEN}, prefix ${CLOUDFLARE_API_TOKEN:0:5}…)"

echo "== token verify (User API Token endpoint)"
resp="$(curl -sS "https://api.cloudflare.com/client/v4/user/tokens/verify" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")"
echo "$resp" | python3 -m json.tool 2>/dev/null || echo "$resp"

if echo "$resp" | grep -q '"status":"active"'; then
  :
elif [[ "$CLOUDFLARE_API_TOKEN" == cfat_* ]]; then
  echo
  echo "note: tokens starting with cfat_ are often Account API Tokens." >&2
  echo "  /user/tokens/verify may return 1000 even when the token works for Workers." >&2
  echo "  For GitHub Actions, prefer: Profile → API Tokens → Create Token → Edit Cloudflare Workers," >&2
  echo "  scoped to account 0e2e76e6… (Devrecated, where ohqs lives) or migrate to OpenHat." >&2
  echo "  Continuing with wrangler whoami…" >&2
elif echo "$resp" | grep -q '"code":1000'; then
  echo "error: Invalid API Token (1000) — wrong secret, truncated paste, or revoked token." >&2
  echo "  Use two separate lines when exporting:" >&2
  echo "    export CLOUDFLARE_API_TOKEN='…'" >&2
  echo "    export CLOUDFLARE_ACCOUNT_ID='…'" >&2
  exit 1
else
  echo "token not active — create a new API token (see deploy/worker/README.md)" >&2
  exit 1
fi

echo "== wrangler whoami (deploy/worker)"
(
  cd "$ROOT/deploy/worker"
  export CLOUDFLARE_API_TOKEN
  if [[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
    export CLOUDFLARE_ACCOUNT_ID
  fi
  npx wrangler whoami
)

if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  echo "warn: CLOUDFLARE_ACCOUNT_ID not set — export it before GitHub secrets / deploy" >&2
  echo "  export CLOUDFLARE_ACCOUNT_ID='${EXPECTED_ACCOUNT_ID}'  # ${EXPECTED_ACCOUNT_NAME}" >&2
else
  echo "== D1 in account CLOUDFLARE_ACCOUNT_ID=${CLOUDFLARE_ACCOUNT_ID}"
  if [[ "$CLOUDFLARE_ACCOUNT_ID" != "$EXPECTED_ACCOUNT_ID" ]]; then
    echo "warn: prod ohqs D1/worker are in ${EXPECTED_ACCOUNT_NAME} (${EXPECTED_ACCOUNT_ID}), not this ID" >&2
  fi
  (
    cd "$ROOT/deploy/worker"
    export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
    out="$(npx wrangler d1 list 2>&1)" || true
    if echo "$out" | grep -q ohqs; then
      echo "$out" | grep ohqs
      echo "ok: D1 ohqs found in this account"
    else
      echo "warn: no D1 named ohqs in account ${CLOUDFLARE_ACCOUNT_ID}" >&2
      if echo "$out" | grep -qiE 'auth|10000|403|not authorized|permission'; then
        echo "  likely cause: API token is not scoped to this account (only OpenHat in token policy?)" >&2
        echo "  fix token: Profile → API Tokens → edit token → Account Resources include Devrecated (${EXPECTED_ACCOUNT_ID})" >&2
      elif echo "$out" | grep -q '│ uuid'; then
        echo "  D1 list succeeded but ohqs missing — database may have been deleted; recreate with: wrangler d1 create ohqs" >&2
      else
        echo "  wrangler d1 list output:" >&2
        echo "$out" | tail -15 >&2
      fi
      if [[ "$CLOUDFLARE_ACCOUNT_ID" != "$EXPECTED_ACCOUNT_ID" ]]; then
        echo "  also set: export CLOUDFLARE_ACCOUNT_ID='${EXPECTED_ACCOUNT_ID}'" >&2
      fi
      echo "  then: gh secret set CLOUDFLARE_ACCOUNT_ID --repo $REPO" >&2
      exit 1
    fi
  )
fi

echo
echo "Account ID must match the row you deploy to (same as wrangler.toml D1 / Worker account)."
echo "Update GitHub secrets:"
echo "  gh secret set CLOUDFLARE_API_TOKEN --repo $REPO"
echo "  gh secret set CLOUDFLARE_ACCOUNT_ID --repo $REPO"
