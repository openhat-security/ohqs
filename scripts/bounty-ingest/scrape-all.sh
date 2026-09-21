#!/usr/bin/env bash
#
# Free bounty-contract pipeline: pull public program listings from the free
# sources, normalize to catalog/contracts.yaml.
#
#   ./scrape-all.sh                          bounty-targets-data only (zero creds)
#   BOUNTY_SOURCES=bounty-targets,bbscope ./scrape-all.sh
#   BOUNTY_SOURCES=apify-hacktivity APIFY_TOKEN=… ./scrape-all.sh --reports
#
# See scrape-all.mjs / README.md for the source matrix and credentials.
set -euo pipefail
cd "$(dirname "$0")"

SOURCES="${BOUNTY_SOURCES:-bounty-targets}"
EXTRA="$@"

echo "== scrape-all: sources=$SOURCES $EXTRA"
if echo "$SOURCES" | grep -q bbscope; then
  ./bbscope-pull.sh
fi
node scrape-all.mjs --source "$SOURCES" --out data/contracts-raw.json $EXTRA
node ingest.mjs --in data/contracts-raw.json --out "${CONTRACTS_YAML:-../../catalog/contracts.yaml}" ${BASE_URL:+--base "$BASE_URL"} ${LLM_MODEL:+--model "$LLM_MODEL"} ${RUNHUG_MODEL:+--model "$RUNHUG_MODEL"}
echo "== done. Open a PR with catalog/contracts.yaml, or run runhug-deploy.sh for the LLM pass."