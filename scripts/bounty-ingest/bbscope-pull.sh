#!/usr/bin/env bash
#
# Optional helper: poll the bbscope CLI (sw33tLie/bbscope, v2) and export
# program/scope data for scrape-all.mjs.
#
# bbscope covers HackerOne, Bugcrowd, Intigriti, YesWeHack + Immunefi and
# tracks scope changes over time in a PostgreSQL DB. It needs researcher
# credentials for everything except Immunefi.
#
# Setup:
#   go install github.com/sw33tLie/bbscope/v2@latest
#   # first run creates ~/.bbscope.yaml; fill db_url + creds, OR pass via env:
# Install: https://github.com/sw33tLie/bbscope
# Proxy/dummy creds per platform: ask @adamsiwiec1.
#
# Usage:
#   BB_H1_USER=user BB_H1_TOKEN=token ./bbscope-pull.sh          # H1 only
#   BOUNTY_BB_PLATFORMS="bc,it,ywh" ./bbscope-pull.sh            # custom set
#   Immunefi needs nothing: ./bbscope-pull.sh   (downloads public scope)
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v bbscope >/dev/null 2>&1; then
  echo "bbscope not installed. Get it: go install github.com/sw33tLie/bbscope/v2@latest" >&2
  echo "Docs: https://github.com/sw33tLie/bbscope" >&2
  exit 1
fi

PLATFORMS="${BOUNTY_BB_PLATFORMS:-immunefi}"
OUT="${BBSCOPE_DUMP:-data/bbscope-dump.json}"

# Merge scraped rows into a single export file for scrape-all.mjs
# (best effort across bbscope versions; adjust --format if your CLI differs).
run_poll() {
  local p="$1"; shift
  echo "== bbscope poll $p"
  bbscope poll "$p" "$@"
}

for p in $(echo "$PLATFORMS" | tr ',' ' '); do
  case "$p" in
    h1)       [ -n "${BB_H1_USER:-}" ] && [ -n "${BB_H1_TOKEN:-}" ] && run_poll h1 --user "$BB_H1_USER" --token "$BB_H1_TOKEN" ;;
    bc)       [ -n "${BB_BC_TOKEN:-}" ] && run_poll bc --token "$BB_BC_TOKEN" ;;
    it)       [ -n "${BB_IT_TOKEN:-}" ] && run_poll it --token "$BB_IT_TOKEN" ;;
    ywh)      [ -n "${BB_YWH_EMAIL:-}" ] && [ -n "${BB_YWH_PASS:-}" ] && run_poll ywh --email "$BB_YWH_EMAIL" --password "$BB_YWH_PASS" ;;
    immunefi) run_poll immunefi ;;
    *)        echo "unknown bbscope platform: $p" >&2 ;;
  esac
done

echo "== exporting -> $OUT"
bbscope export --format json --out "$OUT" || \
  bbscope export --output "$OUT" || \
  echo "export failed — check 'bbscope --help' for the export flag (newer/older versions differ). data/bbscope-dump.json can also be written manually (see scrape-all.mjs for schema)." >&2