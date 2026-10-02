#!/usr/bin/env bash
# Deploy static ohqs console (deploy/web) to Vercel production.
#
# Usage:
#   ./scripts/deploy-web.sh           # vercel deploy --prod
#   ./scripts/deploy-web.sh --preview # preview URL only
#
# Requires: vercel CLI (npx vercel or npm i -g vercel), logged in (vercel login).
# First time in deploy/web: vercel link (project web-ukryty-6366 or your team project).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB="$ROOT/deploy/web"
PREVIEW=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --preview) PREVIEW=true; shift ;;
    -h|--help)
      sed -n '2,10p' "$0"
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

if ! command -v vercel >/dev/null 2>&1; then
  echo "vercel CLI not on PATH; using npx vercel@latest" >&2
  VERCEL=(npx --yes vercel@latest)
else
  VERCEL=(vercel)
fi

cd "$WEB"
if [[ ! -f .vercel/project.json ]]; then
  echo "hint: run once from deploy/web: vercel link  (link to production project)" >&2
fi

echo "== deploy/web → Vercel ($([[ "$PREVIEW" == true ]] && echo preview || echo production))"
if [[ "$PREVIEW" == true ]]; then
  "${VERCEL[@]}" deploy
else
  "${VERCEL[@]}" deploy --prod
fi
