# Bounty-contract ingest (contributor project)

The **Bounties → Contracts** tab on the app site lists individual bug bounty
programs (e.g. "Stripe" on HackerOne). **`catalog/contracts.yaml` is generated
from free public sources** so the directory can be indexed into
`/v1/bounties?class=contract`.

**We're looking for a contributor with a proper GPU** (calling @chaseleto) to
keep the ingest cadence going and to run the LLM normalization pass. Anyone can
run the free scrape source right now — no credentials needed.

- **Daily, or at least weekly** — keeping the bounty DB fresh matters.
- The scrape sources need **no tokens**. Optional extras (bbscope creds, an
  Apify token) are documented below. If you need **proxies or dummy
  credentials** for gated platforms, reach out to **@adamsiwiec1**.

## Free sources used (all free, no paid actors)

| Source | Covers | Auth | Notes |
| --- | --- | --- | --- |
| `bounty-targets-data` (arkadiyt) | HackerOne, Bugcrowd, Intigriti, YesWeHack, Federacy (~940 programs) | none | auto-updated dataset, the default; fetch from raw GitHub into JSON |
| `bbscope` CLI (sw33tLie) | HackerOne, Bugcrowd, Intigriti, YesWeHack, Immunefi | researcher creds (Immunefi none) | polls + stores in Postgres, tracks scope changes over time; `bbscope-pull.sh` |
| Apify actor `filakovsky/hackerone-scraper` | HackerOne **hacktivity** (disclosed reports) | `APIFY_TOKEN` (free Apify account) | free tier ≈ 1000 items/run (< 0.2 CU); best-effort, runs under 1 min |
| `openbugbounty` | openbugbounty.org non-profit VDPs | none | bot-protected pages; best-effort, opt-in |

The paid Apify actors in the original wish list (ParseForge/`$7.69/1k`,
GetAScraper/`$3.99/1k`, Anshuman Atrey/`$5/1k`, TheScrapeLab, automation-lab,
Bug Bounty Finder) bill **per 1,000 records**, so we deliberately skip them —
the free sources above already cover their platforms.

## How it works

```
scrape-all.sh        →   scrape-all.mjs       →   ingest.mjs
(bbscope-pull.sh)*        (free source fetch)      (LLM normalize)
                              ↓                        ↓
                         data/contracts-raw.json  catalog/contracts.yaml
```

`runhug-deploy.sh` is the "repeatable runhug script": it uses
[`runhug`](https://github.com/adamsiwiec1/runhug) to find a good Hugging Face
model and deploy it — either locally with `RUNHUG_LOCAL=1` (your own GPU) or
serverless on RunPod (billed per second, "pennies"). If no model endpoint is
reachable the pipeline still completes with the deterministic normalizer.

## Setup

```bash
# base pipeline needs only Node 18+ (fetch).

# optional 1: bbscope CLI (Programs + scopes + change tracking)
go install github.com/sw33tLie/bbscope/v2@latest   # first run makes ~/.bbscope.yaml

# optional 2: Apify hacktivity feed (free-tier)
bash scripts/bounty-ingest/scripts/install.sh   # n/a — just export APIFY_TOKEN from apify.com free account
```

## Run

```bash
cd scripts/bounty-ingest

# zero-cred default: pull ~940 programs from bounty-targets-data -> catalog/contracts.yaml
./scrape-all.sh

# add bbscope (needs creds; Immunefi is free): BOUNTY_SOURCES=bounty-targets,bbscope ./bbscope-pull.sh
BOUNTY_SOURCES=bounty-targets,bbscope ./scrape-all.sh

# add the hacktivity feed (research/trending disclosures)
BOUNTY_SOURCES=apify-hacktivity APIFY_TOKEN=… ./scrape-all.sh --reports
```

Env | Default | Meaning
--- | --- | ---
`BOUNTY_SOURCES` | `bounty-targets` | comma list: `bounty-targets,bbscope,apify-hacktivity,openbugbounty`
`APIFY_TOKEN` | — | free Apify token for the hacktivity actor
`APIFY_MAX_ITEMS` | `1000` | hacktivity items per run (free tier ceiling ~1000)
`BB_H1_USER`/`BB_H1_TOKEN` | — | HackerOne API token for bbscope
`BB_BC_TOKEN` | — | Bugcrowd `_bugcrowd_session` for bbscope
`BB_IT_TOKEN` | — | Intigriti researcher token for bbscope
`BB_YWH_EMAIL`/`BB_YWH_PASS` | — | YesWeHack login for bbscope
`CONTRACTS_YAML` | `../../catalog/contracts.yaml` | where the generated file goes

To run the LLM pass against a GPU model (recommended for cleaning scope
strings, like bbscope's own LLM-cleanup feature):

```bash
./runhug-deploy.sh                # local GPU
RUNHUG_MODEL="meta-llama/Llama-3.3-70B-Instruct" ./runhug-deploy.sh   # RunPod serverless
```

## After a run

- `catalog/contracts.yaml` has the latest contracts in the catalog schema.
- **Maintainer**: load + embed them so the live site serves them (idempotent,
  vectors are preserved):
  ```bash
  node seed-contracts.mjs --in data/contracts-raw.json --out ../../dist/d1/seed_contracts.sql
  cd ../../deploy/worker && wrangler d1 execute ohqs --remote --file=../../dist/d1/seed_contracts.sql    # inserts contract rows only
  cd ../../scripts/bounty-ingest && ./embed-edge.sh contract                                           # vectorizes them in chunks
  ```
  `/v1/bounties?class=contract` then lists/searches them; the site's Contracts
  tab shows the data (with the contributor banner). Re-runs are safe — records
  are `INSERT OR REPLACE`, FTS is rebuilt for touched ids, vectors untouched.
- **Contributors**: submit a PR with the updated `catalog/contracts.yaml` so it
  gets seeded; the app's Contracts tab shows the data.

## Known gaps / where to contribute

- **bounty-targets-data subset**: reflects only open programs the dataset tracks
  (HackerOne ~450, Bugcrowd ~280, Intigriti ~150, YesWeHack ~60, Federacy 1).
- **bbscope** adds Immunefi + full scope change-tracking but needs researcher
  creds (Immunefi is free). Dummy accounts / proxies: @adamsiwiec1.
- **Apify free tier**: only the hacktivity feed is free; program actors are
  pay-per-event and excluded.
- Selector/page changes on openbugbounty will need patching in `scrape-all.mjs`.

Citing the runhug mantra: find the best HF model → deploy on RunPod in minutes →
run it for pennies. And the contract database: every run refreshes it for free.