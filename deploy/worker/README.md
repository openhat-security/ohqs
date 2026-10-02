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

**Account alignment (important):** In this repo, Worker **`ohqs`** and D1 **`ohqs`** (`database_id` in `wrangler.toml`) currently live in **Devrecated Solutions** — account ID `0e2e76e6a07a520ca302a94076f16139`. They are **not** in OpenHat Security (`06f4119e62016ec11568bb0558eaa7f3`) yet.

GitHub Actions must use an API token **scoped to the same account** as `CLOUDFLARE_ACCOUNT_ID`. A token only allowed on OpenHat cannot deploy the Devrecated worker (Cloudflare `Authentication error [code: 10000]`).

Set repo secrets once (must match the account where Worker `ohqs` and D1 `ohqs` live):

```bash
./scripts/verify-cloudflare-deploy.sh   # local check before updating GitHub
gh secret set CLOUDFLARE_API_TOKEN --repo openhat-security/ohqs
gh secret set CLOUDFLARE_ACCOUNT_ID --repo openhat-security/ohqs
```

**API token permissions** (Custom token or “Edit Cloudflare Workers” template):

| Permission | Access |
| --- | --- |
| Account → Workers Scripts | Edit |
| Account → Workers Routes | Edit |
| Account → D1 | Edit |
| Account → Workers R2 Storage | Edit (if used) |
| Account → Workers KV Storage | Edit (if used) |
| Account → Account Settings | Read |
| User → User Details | Read |

Scope the token to the **same account** as `CLOUDFLARE_ACCOUNT_ID`. A valid token for account A with `ACCOUNT_ID` set to account B fails deploy with `Authentication error [code: 10000]`.

Account ID: `cd deploy/worker && CLOUDFLARE_ACCOUNT_ID=0e2e76e6a07a520ca302a94076f16139 npx wrangler d1 list` — should list `ohqs`.

To deploy into **OpenHat Security** instead, create D1 + first deploy there, then change `database_id` in `wrangler.toml` and point secrets at `06f4119e62016ec11568bb0558eaa7f3`.

Worker secrets (LLM keys, etc.) stay in Cloudflare — set with `npx wrangler secret put …`, not in GitHub Actions env unless you intentionally sync them.
