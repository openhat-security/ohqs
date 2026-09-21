# Bounty-contract ingest (contributor project)

The **Bounties → Contracts** tab on the app site lists individual bug bounty
programs (e.g. "Stripe" on HackerOne). Those are hosted inside marketplaces and
are **not scraped yet** — we don't have the compute and we're out of AI credits.

**We're looking for a contributor with a proper GPU** (calling @chaseleto) to
scrape and ingest these on a schedule, and to keep this script reusable so
anyone else with a GPU can run it too.

- **Daily, or at least weekly** — keeping the bounty DB fresh matters.
- If you need **proxies or dummy credentials** per platform to scrape, reach
  out to **@adamsiwiec1**.

## How it works

```
runhug-deploy.sh   →   scrape.mjs          →   ingest.mjs
(runhug GPU)            (Playwright)           (LLM normalize)
                            ↓                        ↓
                       raw JSON rows          catalog/contracts.yaml
```

The "repeatable runhug script" is `runhug-deploy.sh`. It uses
[`runhug`](https://github.com/adamsiwiec1/runhug) to find a good Hugging Face
model and deploy it — either:

- **your own GPU** (`RUNHUG_LOCAL=1`): no spend, runs locally; or
- **RunPod serverless vLLM** (billed per second, "run it for pennies"): others
  without a GPU can contribute remotely.

## Setup

```bash
# runhug CLI: find the best HF model, deploy to Runpod in minutes
curl -fsSL https://raw.githubusercontent.com/adamsiwiec1/runhug/main/scripts/install.sh | bash   # or see the runhug repo

# scraper deps (Playwright)
cd scripts/bounty-ingest
npm init -y && npm i playwright && npx playwright install chromium
```

## Run

```bash
# your own GPU
RUNHUG_LOCAL=1 ./runhug-deploy.sh

# or deploy a model serverless (cheap, pennies)
RUNHUG_MODEL="meta-llama/Llama-3.3-70B-Instruct" ./runhug-deploy.sh

# gated platforms: dummy credentials + proxy (via @adamsiwiec1)
BOUNTY_CREDS='{"hackerone":{"user":"u","pass":"p","proxy":"http://…"}}' ./runhug-deploy.sh
```

Tuning:

| env | default | meaning |
| --- | --- | --- |
| `RUNHUG_MODEL` | `meta-llama/Llama-3.3-70B-Instruct` | HF model to deploy (fit it to your VRAM) |
| `RUNHUG_LOCAL` | `0` | `1` = use your local GPU instead of RunPod |
| `BOUNTY_CREDS` | `{}` | per-platform dummy accounts + proxy |
| `BOUNTY_PLATFORMS` | all | only scrape some (e.g. `hackerone,immunefi`) |
| `BOUNTY_CONCURRENCY` | `2` | parallel browser contexts (be polite) |

## After a run

`catalog/contracts.yaml` now has new `kind: contract` records matching the
catalog schema. **Submit a PR** with the changes. The maintainer re-indexes so
`/v1/bounties?class=contract` starts answering with real data — until then the
app shows a "contracts aren't scraped yet" notice.

## Known gaps / where to contribute

- **Per-platform adapters** live in `scrape.mjs` (`run(domain, page)`). HackerOne,
  Intigriti, Synack, Bugcrowd gate directories behind logins — selectors are the
  TODO integration point.
- **Ingest quality**: `ingest.mjs` batches rows through the deployed model to
  normalize scope/payout. Improve the prompt or add structured output.
- Expect **selectors to rot** as marketplaces ship UI changes; PRs welcome.

Citing the runhug mantra: find the best HF model → deploy on RunPod in minutes →
run it for pennies. Every run keeps the bounty DB current.