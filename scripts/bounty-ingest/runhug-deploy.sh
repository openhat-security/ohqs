#!/usr/bin/env bash
#
# Repeatable bounty-ingest GPU runner.
#
# Deploys a GPU model with runhug (https://github.com/adamsiwiec1/runhug) and
# runs the scrape -> LLM-ingest pass to keep the ohqs catalogue bounty data up
# to date. Run it daily, or at least weekly. Anyone with a GPU can contribute.
#
#   LOCAL GPU (your own box, e.g. @chaseleto):
#     RUNHUG_LOCAL=1 ./runhug-deploy.sh
#
#   MODELS hosted on RunPod (serverless vLLM, billed per second — "pennies"):
#     RUNHUG_MODEL="meta-llama/Llama-3.3-70B-Instruct" ./runhug-deploy.sh
#
# Pick a model that fits your card. Find one with:
#     runhug search -q "fast instruct llm for extraction"
#     runhug gpus
#
# Credentials/proxies for gated platforms (HackerOne, Intigriti, …) aren't
# hard-coded. Reach out to @adamsiwiec1 for per-platform dummy accounts /
# proxies; pass them as:
#     BOUNTY_CREDS='{"hackerone":{"user":"u","pass":"p","proxy":"http://…"}}'
#     BOUNTY_CONCURRENCY=4 ./runhug-deploy.sh
set -euo pipefail

cd "$(dirname "$0")"

MODEL="${RUNHUG_MODEL:-meta-llama/Llama-3.3-70B-Instruct}"
LOCAL="${RUNHUG_LOCAL:-0}"
RAW_DATA="${RAW_DATA:-data/contracts-raw.json}"
OUT_YAML="${OUT_YAML:-../../../catalog/contracts.yaml}"

echo "== runhug bounty-ingest =="
echo "model : $MODEL"
echo "local : $LOCAL"

if ! command -v runhug >/dev/null 2>&1; then
  echo "-> runhug not found. Install:"
  echo "   curl -fsSL https://raw.githubusercontent.com/adamsiwiec1/runhug/main/scripts/install.sh | bash"
  exit 1
fi

BASE=""
if [ "$LOCAL" = "1" ]; then
  echo "-> local mode: runhug local setup (serves ~/runhug/local at 127.0.0.1:8001/v1)"
  runhug local setup
  BASE="http://127.0.0.1:8001/v1"
else
  echo "-> remote mode: runhug connect + deploy '$MODEL'"
  runhug connect || true
  DEPLOY_OUT="$(runhug deploy "$MODEL" --type QUEUE)"
  DEPLOY_ID="$(echo "$DEPLOY_OUT" | grep -oE '([a-zA-Z0-9]{10,})' | head -1 || true)"
  if [ -n "$DEPLOY_ID" ]; then
    BASE="$(runhug url "$DEPLOY_ID" || true)"
  fi
  if [ -z "$BASE" ]; then
    echo "!! could not auto-resolve the endpoint. Set it manually:" >&2
    echo "   BASE_URL='https://api.runpod.ai/v2/<endpoint>/openai/v1' ./runhug-deploy.sh" >&2
    BASE="${BASE_URL:-}"
  fi
fi

[ -n "$BASE" ] && echo "-> OpenAI base: $BASE"

echo "-> scraping bounty marketplaces (Playwright)"
node scrape.mjs --out "$RAW_DATA"

echo "-> LLM ingest pass -> $OUT_YAML"
node ingest.mjs ${BASE:+--base "$BASE"} --model "$MODEL" --in "$RAW_DATA" --out "$OUT_YAML"

echo
echo "== done =="
echo "Next (maintainer): index it so /v1/bounties?class=contract has data."
echo "Contributing: open a PR with the updated catalog/contracts.yaml."
echo "Keep the DB fresh — run daily, or at least weekly."