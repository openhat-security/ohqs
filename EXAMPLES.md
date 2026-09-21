# ohqs CLI examples

`ohqs` is OpenHat Quick Start. From the `quick-start` repo root:

```bash
git clone <this-repo>            # catalog + ohqs only — do not use --recurse-submodules
make                             # build, put ohqs on PATH, index, open the UI
make submodules                  # optional: shallow-fetch every third-party tree
./bin/ohqs submodules            # same
./bin/ohqs submodules gitleaks   # one catalog id
make stop
make help
```

Third-party checkouts are git submodules and are **not** part of a default clone. `ohqs install` fetches only what a playbook needs. Full notes: [README.md](README.md#clone-and-submodules).

Every `recommend` example requires **`--authorized`** and a written **`--scope`**. `ohqs` will not plan without both. It does not generate exploits.

Replace hosts, programs, and paths with assets you are allowed to test.

---

## Help and setup

```bash
./bin/ohqs --help
./bin/ohqs recommend --help
./bin/ohqs setup          # Kali / Exegol / BlackArch notes
./bin/ohqs configure      # repo, catalog, index paths the CLI resolved
```

---

## Index and search

Rebuild the local SQLite FTS index from `catalog/` (and README snippets when a `submodule_path` exists):

```bash
./bin/ohqs index
# indexed 189 records -> data/ohqs.sqlite
```

Vector search: persist embeddings once (needs Ollama `nomic-embed-text` running, or `HF_TOKEN` exported), or just download the prebuilt vectorized index from the release:

```bash
./bin/ohqs index --semantic          # rebuild + embed (10–20 min for ~475 records)
./bin/ohqs index download            # or: fetch the release-built, vectorized index — no local embedding
./bin/ohqs index download --force    # overwrite with the newest release build
```

Search uses lexical FTS + tags by default and reranks with the vectors when they exist:

```bash
./bin/ohqs search nuclei
./bin/ohqs search "secrets ai slop"
./bin/ohqs search "jwt auth" --no-semantic   # force lexical only
./bin/ohqs search "firefox proxy" --json
```

Print one catalog record (install, how, look_for, commands):

```bash
./bin/ohqs show gitleaks
./bin/ohqs show semgrep
./bin/ohqs show pwnfox
./bin/ohqs show kali
```

---

## Recommend a playbook

Flags:

| Flag | Meaning |
| --- | --- |
| `--authorized` | You have permission for the stated scope |
| `--scope` | Program, RoE, hosts, out-of-scope |
| `--situation` | Stack, bounty vs SMB audit, AI-built, LLM feature, … |
| `--target` | Fills `{{url}}` / `{{domain}}` / `{{target}}` |
| `--path` | Local source for SAST/secrets (default `.`) |
| `--wordlist` | Optional ffuf/gobuster list |
| `--export PATH` | Write a commented `commands.sh` (directory or `.sh` file) |
| `--llm` | Draft the plan with your OpenAI-compatible model |
| `--openai-base-url` | Endpoint (saved config, or `OHQS_OPENAI_BASE_URL`) |
| `--openai-api-key` | Key (saved config, or `OHQS_OPENAI_API_KEY`) |
| `--openai-model` | Model name — optional for single-model endpoints (saved config, or `OHQS_OPENAI_MODEL`) |

Bring your own key and endpoint — nothing leaves your machine. Recommend [Unsloth](https://github.com/openhat/unsloth); OpenAI, vLLM, and llama.cpp servers work too. Until the Unsloth repo exists, see [docs/UNSLOTH-REPO-PLAN.md](docs/UNSLOTH-REPO-PLAN.md).

Save it once (stored locally in `data/config.json`, gitignored), then reuse it. For a single-model server the model name is optional — base URL + API key is enough:

```bash
./bin/ohqs configure --save \
  --openai-base-url http://127.0.0.1:8000/v1 \
  --openai-api-key  sk-local
./bin/ohqs recommend --authorized --scope "..." --situation "..." --llm
```

Add `--openai-model <name>` only when the endpoint serves multiple models or requires a specific served name (vLLM, or hosted OpenAI). Per-run `--openai-*` flags (and `OHQS_OPENAI_*` env) still override the saved config.

### Managed local model (fit-aware run)

`recommend` prints a `## Local LLM fit` section sized against your detected GPU/RAM. Install + serve the pick, then reuse it with `--llm`:

```bash
./bin/ohqs models list              # fit check across the recommended GGUFs
./bin/ohqs models install defiant-fable   # Unsloth-managed venv + GGUF download
./bin/ohqs models serve defiant-fable     # OpenAI-compatible endpoint on 127.0.0.1:8001/v1
./bin/ohqs configure --save \
  --openai-base-url http://127.0.0.1:8001/v1 \
  --openai-api-key  sk-local --openai-model defiant-fable
./bin/ohqs recommend --authorized --scope "..." --situation "..." --llm
```

`ohqs models install` refuses models that do not fit your detection (use `--force` to page to disk), and `ohqs models serve --gpu-layers 0` forces CPU.

### AI-generated (“AI slop”) web app

Selects playbook `ai-slop-web` when the situation mentions vibe/Cursor/Next.js/LLM/chat/etc.

```bash
./bin/ohqs recommend \
  --authorized \
  --scope "Customer RoE 2026-08-13: app.example.com and the Git repo they sent. No staging. No DoS." \
  --situation "vibe-coded Next.js SaaS with auth and a chat LLM" \
  --target https://app.example.com \
  --path ./customer-src
```

### In-scope web bug bounty

Selects `bounty-web` for bounty/HackerOne/subdomain-style wording.

```bash
./bin/ohqs recommend \
  --authorized \
  --scope "HackerOne program Example: *.example.com in scope; example.net and third-party Zendesk out of scope" \
  --situation "public bug bounty, need recon then authenticated web testing" \
  --target example.com
```

### SMB external audit

Selects `smb-external` for smb/audit/contract/customer wording.

```bash
./bin/ohqs recommend \
  --authorized \
  --scope "SOW #441: 203.0.113.10 and shop.customer.test only. Window Fri 18:00–22:00 ET." \
  --situation "SMB contract audit of an AI-built customer SaaS" \
  --target https://shop.customer.test \
  --path ./customer-src
```

This prints Markdown to stdout: goal, scope, toolkit, numbered steps (purpose, how, commands, what to look for, next), coverage checklist. For a readable view, run `make start`.

Without authorization it exits:

```bash
./bin/ohqs recommend --situation "anything" --scope "hosts"
# Error: refusing to plan: pass --authorized and a written --scope ...
```

---

## Next.js + Clerk client assessment (rebuild proposal)

Use when the client has a vibe-coded Next.js app with Clerk and you need **evidence for a rebuild contract** — not downtime.

Playbook: `nextjs-clerk` (selected when the situation mentions **Clerk**).

```bash
./bin/ohqs index
./bin/ohqs recommend \
  --authorized \
  --scope "SOW 2026-08: app.client.com + GitHub repo client/app only. Two Clerk test users provided. No DoS." \
  --situation "vibe-coded Next.js App Router SaaS with Clerk auth — full assessment for rebuild decision" \
  --target https://app.client.com \
  --path ./client-repo \
  --export ./ohqs-out/client
```

That writes:

- `ohqs-out/client/commands.sh` — gitleaks, semgrep (incl. Next.js rules), trivy, httpx/katana/nuclei, `ohqs browser`
- `ohqs-out/client/FINDINGS.md` — client report stub (executive summary, finding blocks, coverage checklist)

Workflow:

1. **Install missing tools** (UI or `./bin/ohqs install ...`)
2. **Open test browser** — FoxyProxy, PwnFox, Cookie-Editor pre-installed; sign in as both Clerk test users
3. **Run commands** — or run steps from `commands.sh` one at a time
4. **Manual steps** — middleware audit, webhook verification, IDOR in proxy (see `ohqs show nextjs-clerk`)
5. **Fill FINDINGS.md** — attach files from `evidence/`; severity drives rebuild recommendation

```bash
./bin/ohqs show nextjs-clerk
make start   # build playbook in UI with the same situation/scope fields
```

---

## Export a commented command script

`--export` to a **directory** writes `commands.sh` plus **`FINDINGS.md`** (client report stub). A `.sh` path writes only the script.

```bash
./bin/ohqs recommend \
  --authorized \
  --scope "HackerOne program Example: www and api in scope" \
  --situation "vibe-coded Next.js SaaS with auth and a chat feature" \
  --target https://www.example.com \
  --path . \
  --export ./ohqs-out/example
# exported ./ohqs-out/example/commands.sh
```

Or write a file directly:

```bash
./bin/ohqs recommend --authorized --scope "..." --situation "..." \
  --target https://www.example.com \
  --export ./ohqs-out/example.sh
```

Review the script, then run individual commands (or the whole file if you mean to):

```bash
./bin/ohqs run ./ohqs-out/example/commands.sh
# or
bash ./ohqs-out/example/commands.sh
```

The UI has the same download as **Download commands.sh**.

---

## Local web UI and JSON API

```bash
make start
# ohqs  http://127.0.0.1:8787
```

That builds, indexes if needed, replaces an old `ohqs` on 8787, and opens the playbook form. JSON is still at `/v1/*`. `make stop` ends it.

Playbook builds from the CLI (`recommend`, `deps`, `install`), the form, and `POST /v1/recommend` all land in **Playbook history** on that page. Open an entry to reload it. List: `GET /v1/history`.

```bash
curl -s 'http://127.0.0.1:8787/healthz'
curl -s 'http://127.0.0.1:8787/v1/search?q=gitleaks' | head
curl -s 'http://127.0.0.1:8787/v1/tools/semgrep' | head

curl -s http://127.0.0.1:8787/v1/recommend \
  -H 'Content-Type: application/json' \
  -d '{
    "authorized": true,
    "scope": "HackerOne example.com www+api in scope",
    "situation": "vibe-coded Next.js SaaS with a chat LLM",
    "target": "https://www.example.com",
    "path": ".",
    "use_llm": true,
    "openai_base_url": "http://127.0.0.1:8000/v1",
    "openai_api_key": "sk-local",
    "openai_model": "your-model"
  }'
```

`use_llm` plus the `openai_*` fields are optional; when omitted, the API uses your saved `data/config.json` / env, or the template planner.

Listen address is `127.0.0.1:8787` (see `ohqs configure`).

---

## Install only what the playbook needs

`ohqs` detects macOS, Linux (plus distro), or Windows. It leaves tools already on `PATH` alone. Missing ones are shallow-fetched as **submodules** (or cloned if `.gitmodules` is missing) into `third-party-resources/` and built into `bin/tools` — not the entire tree. A default `git clone` of this repo does not download those trees; `make submodules` / `ohqs submodules` is opt-in.

```bash
./bin/ohqs deps
./bin/ohqs deps --authorized --scope "..." --situation "vibe-coded Next.js SaaS with a chat LLM"
./bin/ohqs install --authorized --scope "..." --situation "vibe-coded Next.js SaaS with a chat LLM"
# or
make install-tools AUTHORIZED=1 SCOPE="..." SITUATION="..."
```

The UI playbook page has **Install missing tools** and **Run commands**. Both start a background job under `data/jobs/` (own process, log on disk). Close the tab or restart `make start` and open the job from the list — or `/?job=<id>` — to attach to the same log. Stop / Resume are on the job panel. Interactive proxies (ZAP, mitmproxy) are skipped in Run; do those by hand.

Extensions (FoxyProxy, PwnFox, Cookie-Editor) are force-installed into an **OHQS Browser** sandbox (a private Firefox under `bin/browsers/`, separate Dock icon on macOS). pipx/npm/ZAP stay copy-paste.

```bash
./bin/ohqs browser
```

That downloads Firefox once, writes AMO policies, and opens `data/browser-profiles/ohqs`. Daily Firefox/Chrome is not touched. The UI button is **Open test browser**.

---

## Typical first-day flow

```bash
make build
./bin/ohqs setup
./bin/ohqs index
./bin/ohqs search "ai slop"
./bin/ohqs recommend \
  --authorized \
  --scope "paste your RoE or program policy here" \
  --situation "paste stack + goal here" \
  --target https://in-scope.example \
  --path . \
  --export ./ohqs-out/today
./bin/ohqs install --authorized --scope "paste your RoE or program policy here" --situation "paste stack + goal here"
./bin/ohqs browser
# review ./ohqs-out/today/commands.sh
# or just: make start
```
