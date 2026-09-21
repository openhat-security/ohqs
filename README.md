# OpenHat Quick Start (ohqs)

OpenHat is a workstation catalog and playbook builder for authorized security testing.

`ohqs` helps you find security tools, guides, extensions, and bounty platforms, then turns a situation + written scope into a step-by-step testing playbook.

**It is not an exploit generator.** Playbooks focus on detection, triage, validation, and reporting.

Only use `ohqs` against systems you are explicitly authorized to test.

## Try it now

Live app: **https://web-ukryty-6366.vercel.app**

1. Enter what you're testing
2. Enter your written scope
3. Confirm that you have authorization
4. Click **Build playbook**

The app will suggest relevant tools and steps for the engagement.

## Quick start locally

```bash
git clone <this-repo>
cd quick-start
make
```

Then open **http://127.0.0.1:8787**.

That's it. `make` builds `ohqs`, installs it on your PATH, builds the local search index, and starts the UI.

Prefer the terminal?

```bash
./bin/ohqs search nuclei
./bin/ohqs recommend \
  --authorized \
  --scope "authorized client scope" \
  --situation "vibe-coded Next.js SaaS with authentication"
./bin/ohqs show gitleaks
```

## How it works

The catalog is stored as YAML in `catalog/`.

`ohqs` indexes that catalog locally and uses it to match a situation to relevant tools and playbooks.

```
catalog YAML
     ↓
local search index
     ↓
playbook matching
     ↓
reviewed plan
     ↓
commands / findings / tools
```

Semantic search can also be enabled with vector embeddings.

If you provide an OpenAI-compatible model, `ohqs` can use it to draft the plan. The authorization and scope gates still apply.

## What you can do

- Search the security catalog
- Build playbooks for authorized engagements
- Export a reviewed `commands.sh`
- Install tools required by a playbook
- Run reviewed commands locally
- Open an isolated test browser
- Use local or hosted OpenAI-compatible models
- Browse the catalog through the web UI
- Browse bounty **marketplaces** and **programs** (Bounties tab)

## Bounty contracts — get involved

The Bounties tab splits bounty/VDP listings into **marketplaces** (HackerOne,
Bugcrowd, Immunefi, …), **programs** (single-org: MSRC, Apple, CERTs, …), and
**contracts** (the individual programs inside marketplaces — live, ~930+ on the
Bounties tab now).

Contracts come from free sources (bounty-targets-data, bbscope) refreshed on a
schedule; the LLM scope-cleaning pass runs on a contributor's GPU.

- Cadence: **daily, or at least weekly**.
- Powered by [`runhug`](https://github.com/adamsiwiec1/runhug) — deploy a good
  HF model on RunPod in minutes, run it for pennies, or run it locally.
- Pipeline: `scripts/bounty-ingest/` (scrape-all → ingest → seed-contracts →
  embed-edge).
- Calling @chaseleto and any GPU contributor to keep the refresh going.
- Need proxies or dummy credentials per platform? Reach out to **@adamsiwiec1**.

## CLI

Build first with `make`:

```bash
./bin/ohqs serve
```

Useful commands:

```bash
# Search the catalog
./bin/ohqs search nuclei

# Inspect a catalog entry
./bin/ohqs show gitleaks

# Build an authorized playbook
./bin/ohqs recommend \
  --authorized \
  --scope "HackerOne program example.com, in-scope www and api" \
  --situation "Next.js SaaS with auth and a chat feature" \
  --target https://app.example.com

# Draft with your configured model
./bin/ohqs recommend --authorized --scope "..." --situation "..." --llm

# Check dependencies
./bin/ohqs deps --authorized --scope "..." --situation "..."

# Install tools needed by a playbook
./bin/ohqs install --authorized --scope "..." --situation "..."

# Open the isolated browser
./bin/ohqs browser
```

## Command reference

| Command | Purpose |
| --- | --- |
| `serve` | Start the local UI and API |
| `search <query>` | Search the catalog |
| `show <id>` | Show a catalog record |
| `recommend` | Build an authorized playbook |
| `recommend --llm` | Draft a playbook with your model |
| `index` | Build the local search index |
| `index --semantic` | Build the index with embeddings |
| `index download` | Download the prebuilt vectorized index |
| `ingest` | Import entries from a curated source |
| `ingest github` | Import GitHub projects for catalog review |
| `models list` | Show models that fit your hardware |
| `models install <id>` | Install a supported local model |
| `models serve <id>` | Serve a local model |
| `deps` | Check installed dependencies |
| `install` | Install missing playbook tools |
| `browser` | Open the isolated test browser |
| `run` | Run a reviewed `commands.sh` |
| `setup` | Show Kali / Exegol / BlackArch setup notes |
| `configure` | Show local configuration |
| `submodules` | Opt-in fetch of upstream resources |

## Browser UI

The local UI runs at **http://127.0.0.1:8787**.

From the UI you can:

- Build an authorized playbook
- Search the catalog
- Draft a plan with your own model
- Download `commands.sh`
- Install missing tools
- Run reviewed commands
- Open the isolated test browser

The JSON API is available from the same process:

```
GET  /healthz
GET  /v1/search?q=
GET  /v1/index
GET  /v1/tools/{id}
GET  /v1/models
POST /v1/recommend
POST /v1/deps
GET  /v1/history
```

## Local models

`ohqs` can use any OpenAI-compatible endpoint.

Your model is responsible for drafting the plan; `ohqs` provides the catalog, authorization gate, scope, and execution workflow.

For a local server:

```bash
./bin/ohqs configure --save \
  --openai-base-url http://127.0.0.1:8000/v1 \
  --openai-api-key sk-local
```

Then:

```bash
./bin/ohqs recommend --authorized --scope "..." --situation "..." --llm
```

Environment variables work too:

```bash
export OHQS_OPENAI_BASE_URL=http://127.0.0.1:8000/v1
export OHQS_OPENAI_API_KEY=sk-local
export OHQS_OPENAI_MODEL=your-model
```

Configuration is stored locally in `data/config.json`, which is gitignored.

The model is prompted for an authorized security-testing plan, not exploit payloads. If the model response cannot be parsed, `ohqs` falls back to its deterministic template playbook.

## Catalog

The catalog contains:

- Security tools
- Browser extensions
- Guides and cheat sheets
- Reference documentation
- Operating systems
- Bug bounty platforms
- Scan indexes and other security resources

The YAML records in `catalog/` are the source of truth.

The catalog inventory is documented in `REFERENCES.md`.

Search it with:

```bash
./bin/ohqs search <query>
```

or use the search box in the web UI.

## Upstream resources

The repository can optionally include upstream security-tool repositories under `third-party-resources/`.

They are not cloned by default.

A normal clone is enough to use the catalog and `ohqs`:

```bash
git clone <this-repo>
```

To fetch upstream resources later:

```bash
make submodules
```

Or fetch a specific catalog entry:

```bash
./bin/ohqs submodules gitleaks
```

**Do not use `--recurse-submodules`** unless you intentionally want to download the upstream trees.

See `third-party-resources/README.md` for details.

## Ingesting more resources

You can import additional resources into a review file before adding them to the index.

Curated sources:

```bash
./bin/ohqs ingest --from awesome-web-security
```

GitHub:

```bash
./bin/ohqs ingest github --topics c2,reconnaissance
```

Imported records are written to `catalog/ingested.yaml`.

They are de-duplicated and tagged for review before indexing.

Run `./bin/ohqs ingest --help` for all available options.

## Examples & contributing

- `EXAMPLES.md` — worked examples
- `CONTRIBUTING.md` — adding catalog records
- `REFERENCES.md` — catalog inventory
- `third-party-resources/README.md` — upstream resources

## Project layout

```
ohqs/                    Go application
catalog/                 YAML catalog
third-party-resources/   Optional upstream repositories
REFERENCES.md            Catalog inventory
docs/                    Additional documentation
```

## License

First-party ohqs code, catalog data, scripts, documentation, and the frontend are **GPLv3**.

Upstream projects under `third-party-resources/` retain their own licenses. This repository does not relicense projects such as Metasploit, Wireshark, or SecLists.

See `LICENSE` and `NOTICE`.