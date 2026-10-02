#!/usr/bin/env bash
# Deploy OpenHat portal (Next.js) on the marketing Vercel project → openhat-website.vercel.app
#
# Portal routes (/dashboard/tokens, /login, …) live in openhat-www (merged from openhat-portal).
#
# Usage:
#   ./scripts/deploy-portal.sh           # vercel deploy --prod
#   ./scripts/deploy-portal.sh --preview
#
# Requires: vercel CLI, AUTH_SECRET + KEYCLOAK_* set in Vercel project env for prod auth.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WWW="${OPENHAT_WWW_DIR:-$ROOT/../../openhat-www}"
PREVIEW=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --preview) PREVIEW=true; shift ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ ! -f "$WWW/package.json" ]]; then
  echo "openhat-www not found at: $WWW" >&2
  echo "set OPENHAT_WWW_DIR to your checkout (Next app with /dashboard/tokens)" >&2
  exit 1
fi

if ! command -v vercel >/dev/null 2>&1; then
  VERCEL=(npx --yes vercel@latest)
else
  VERCEL=(vercel)
fi

cd "$WWW"
if [[ ! -f .vercel/project.json ]]; then
  echo "hint: cd openhat-www && vercel link  (project: openhat-website)" >&2
fi

echo "== openhat-www (portal + marketing) → Vercel ($([[ "$PREVIEW" == true ]] && echo preview || echo production))"
if [[ "$PREVIEW" == true ]]; then
  "${VERCEL[@]}" deploy
else
  "${VERCEL[@]}" deploy --prod
fi
