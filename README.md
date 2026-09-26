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

## Free Public API

The hosted edge API at **https://api.openhat.io** provides free access to the catalog and playbook builder.

### Endpoints

| Endpoint | Method | Description | Rate Limit (min/hr/day) |
| --- | --- | --- | --- |
| `/v1/search` | GET | Search the security catalog (tools, guides, extensions, etc.) | 5 / 25 / 100 |
| `/v1/bounties` | GET | List bug bounty platforms/programs/contracts | 30 / 100 / 300 |
| `/v1/models` | GET | Get model recommendations for your hardware | 30 / 100 / 300 |
| `/v1/tools/{id}` | GET | Get a single catalog record by ID | 10 / 50 / 200 |
| `/v1/index` | GET | Check index status (records, vectors, embedder) | 30 / 100 / 300 |
| `/v1/recommend` | POST | Build an authorized playbook (LLM-powered via OpenRouter free tier) | 2 / 10 / 25 |
| `/v1/llm/models` | GET | List available LLM models (OpenRouter free router + Workers AI) | 20 / 50 / 150 |
| `/v1/auth/signup` | POST | Self-serve Keycloak user (role `client`) | — |
| `/v1/auth/login` | GET | Start Keycloak OIDC login | — |
| `/v1/tokens` | POST/GET | Mint/list client API tokens (Keycloak session) | — |
| `/v1/auth/verify` | GET | Verify Keycloak or API token | — |
| `/healthz` | GET | Health check | — |

### Rate Limits

All endpoints are **strictly rate limited** per IP and per authenticated user (the stricter of the two applies) across **three time windows**:

- **Catalog search (`/v1/search`)**: 5/min, 25/hr, 100/day
- **Playbook creation (`/v1/recommend`)**: 2/min, 10/hr, 25/day
- **Tool details (`/v1/tools/{id}`)**: 10/min, 50/hr, 200/day
- Other endpoints have higher limits (see table)

Rate limit headers are included in responses:
- `X-RateLimit-Limit` — max requests in minute window
- `X-RateLimit-Limit-Hour` — max requests in hour window
- `X-RateLimit-Limit-Day` — max requests in day window
- `X-RateLimit-Remaining` — requests left in the strictest window
- `X-RateLimit-Reset` — Unix ms when the strictest window resets
- `Retry-After` — seconds until next request allowed (on 429)

On 429 responses, the JSON body includes `"window": "minute|hour|day"` indicating which limit was exceeded.

### Authentication (optional)

Authenticated calls use an opaque **client API token** (minted after Keycloak login). Client tokens are metered by `token_id` + IP; hashes only are stored at rest. See [docs/auth-keycloak.md](docs/auth-keycloak.md).

```bash
curl -H "Authorization: Bearer <CLIENT_API_TOKEN>" https://api.openhat.io/v1/search?q=nuclei
```

Admin AI tokens exist for ops embed/LLM work only — never put them in README examples, CLI defaults, or www.

### CLI Authentication

Generate a token via the CLI (mocks Keycloak/OIDC for now):

```bash
# Get a token (prints to stdout)
ohqs auth token --email you@example.com

# Save token locally for subsequent commands
ohqs auth token --save --email you@example.com

# Verify token
ohqs auth verify

# Login flow (opens browser to Keycloak in production)
ohqs auth login --email you@example.com --no-browser
```

The token is saved to `data/token.json` (gitignored) and automatically used by CLI commands that call the edge API.

### Examples

**Search the catalog:**
```bash
curl "https://api.openhat.io/v1/search?q=nuclei&limit=10"
```

**Build a playbook (requires `--authorized` gate):**
```bash
curl -X POST https://api.openhat.io/v1/recommend \
  -H "Content-Type: application/json" \
  -d '{
    "authorized": true,
    "scope": "example.com, in-scope www and api",
    "situation": "Next.js SaaS with auth and a chat feature"
  }'
```

**Get model recommendations for your hardware:**
```bash
curl "https://api.openhat.io/v1/models?ramgb=16&vramgb=0&limit=6"
```

**List available LLM models (OpenRouter free router):**
```bash
curl "https://api.openhat.io/v1/llm/models"
```

### LLM Backend

The `/v1/recommend` LLM planner uses **OpenRouter's free router** (`inclusionai/ling-3.0-flash-fin:free`) by default. No API key required for the free tier.

To use a different model, pass `model` in the request body (must match an available OpenRouter model):

```bash
curl -X POST https://api.openhat.io/v1/recommend \
  -H "Content-Type: application/json" \
  -d '{
    "authorized": true,
    "scope": "...",
    "situation": "...",
    "model": "openrouter/auto"
  }'
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