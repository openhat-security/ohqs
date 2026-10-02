# ohqs Cloudflare Worker

Edge API + static UI (`deploy/web` via `[assets]` in `wrangler.toml`).

## Local

```bash
npm ci
npx wrangler dev --ip 127.0.0.1 --port 8788
```

Copy `.dev.vars.example` → `.dev.vars` for local secrets (never commit).

## GitHub Actions deploy

Workflow: [`.github/workflows/deploy-worker.yml`](../../.github/workflows/deploy-worker.yml)

Runs on push to `main` when `deploy/worker/**`, `deploy/web/**`, or `catalog/**` change, or via **Actions → Deploy worker → Run workflow**.

From the repo root:

```bash
./scripts/gh-deploy.sh              # check → commit deploy paths → push → run workflow
./scripts/gh-deploy.sh --check-only
./scripts/gh-deploy.sh --dispatch-only   # re-deploy without push
```

Set repo secrets once:

```bash
# API token needs Workers Scripts:Edit (and related Workers permissions)
gh secret set CLOUDFLARE_API_TOKEN
gh secret set CLOUDFLARE_ACCOUNT_ID
```

Account ID for this project’s Cloudflare account is shown by `npx wrangler whoami`.

Worker secrets (LLM keys, etc.) stay in Cloudflare — set with `npx wrangler secret put …`, not in GitHub Actions env unless you intentionally sync them.
