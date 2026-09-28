# OHQS auth (Keycloak + API tokens)

Local-first auth for OpenHat Quick Start. Reuses the existing Keycloak realm
`openhat` (same Docker stack as openhat-portal).

**Product rule:** OHQS web console (`:8788`) has **no login**. Clients mint
opaque `ohqs_*` API tokens in **openhat-portal** (`:3210` → `/dashboard/tokens`),
then use them from the CLI (`OHQS_API_TOKEN`) or `Authorization: Bearer ohqs_…`.

## Pieces

| Piece | Purpose |
|-------|---------|
| Keycloak realm `openhat` | Users + realm roles (`client`, `operator`, `admin`) |
| Client `openhat-portal` | Portal browser OIDC (Auth.js) — owns login/session |
| OHQS Worker JWKS verify | Accepts portal user's Keycloak **access JWT** (Bearer) for mint/list/revoke/usage |
| Opaque API tokens | Minted by the Worker after KC JWT check; hashed at rest |
| Durable Object rate limiter | Keys `token:${token_id}` (+ IP) for `client` tokens |
| D1 `api_tokens` / `api_usage` | Token metadata + per-call audit |

Console cookie OIDC (`ohqs-api` login/callback/session) is **removed**. Prefer
portal → Worker with `Authorization: Bearer <kc_access_token>`.

## Token types

1. **Client API token** (`type=client`, prefix `ohqs_c_…`)
   - Any portal user with a valid Keycloak access JWT may mint via `POST /v1/tokens`
     (portal Tokens page).
   - Metered via the existing DO rate limiter keyed by `token:${token_id}` and IP.
   - Every authenticated call is audited: token_id, user_sub, route, method, IP, UA, status, bytes, ts.
   - **Only a SHA-256 hash is stored** — raw token shown once at mint.

2. **Admin AI token** (`type=ai_admin`, prefix `ohqs_a_…`)
   - Only realm role `admin` may mint (`POST /v1/tokens/ai` or `POST /v1/tokens` with `{ "type": "ai_admin" }`).
   - Mint UX is **portal-only** (admin section on Tokens page) — not on OHQS www/console.
   - **No client rate limits**, but every use is still audited.
   - **Never** embed in CLI defaults, README examples, or www.
   - Rotate/revoke via `POST /v1/tokens/:id/revoke`.

Clients cannot mint AI tokens.

## Local env (Worker)

```bash
cd deploy/worker
cp .dev.vars.example .dev.vars
```

```
KEYCLOAK_ISSUER=http://localhost:8080/realms/openhat
# Optional (legacy ohqs-api client — not required for JWKS mint path):
# KEYCLOAK_CLIENT_ID=ohqs-api
# KEYCLOAK_CLIENT_SECRET=…
# Optional emergency local-only embed gate — prefer ai_admin token instead:
# ADMIN_TOKEN=
# Optional Flexprice sandbox metering (see section below):
# FLEXPRICE_API_KEY=
# FLEXPRICE_API_BASE=https://api.cloud.flexprice.io/v1
# FLEXPRICE_EVENT_NAME=ohqs.api_call
```

`.dev.vars` is gitignored. Never commit secrets.

## Run locally

1. Start Keycloak (from openhat-portal): `npm run keycloak:up` → http://localhost:8080
2. Start portal: `npm run dev` → http://localhost:3210
3. Apply D1 migrations + run worker:

```bash
cd deploy/worker
npx wrangler d1 migrations apply ohqs --local
npx wrangler dev --ip 127.0.0.1 --port 8788
# → http://127.0.0.1:8788  (catalog console, no Account tab)
```

4. In portal (signed in as `client` or `admin`): open **API tokens**
   (`/dashboard/tokens`) → Mint client token → copy once.
5. CLI:

```bash
export OHQS_API_TOKEN=ohqs_c_…   # client token only — never an ai_admin token
export OHQS_API=http://127.0.0.1:8788
curl -H "Authorization: Bearer $OHQS_API_TOKEN" "$OHQS_API/v1/search?q=nuclei"
```

## API surface (auth)

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/v1/auth/verify` | Bearer KC or `ohqs_*` | Introspection |
| POST | `/v1/tokens` | Keycloak access JWT | Mint `client` (or `ai_admin` if admin) |
| POST | `/v1/tokens/ai` | Keycloak + role `admin` | Mint `ai_admin` |
| GET | `/v1/tokens` | Keycloak access JWT | List own tokens (prefix/type/dates; never hash/raw) |
| POST | `/v1/tokens/:id/revoke` | Keycloak access JWT | Revoke |
| GET | `/v1/usage` | Keycloak access JWT | Own usage summary |
| GET | `/v1/tokens/usage` | Keycloak access JWT | Alias of `/v1/usage` |

Removed from OHQS (use portal login instead): `/v1/auth/login`, `/v1/auth/callback`,
`/v1/auth/logout`, `/v1/auth/signup`, `/v1/auth/me`, and the `ohqs_session` cookie.

Public catalog reads (`/v1/search`, `/v1/bounties`, `/v1/models`, `/v1/index`, `/v1/tools/*`, `/v1/llm/models`) stay public with IP rate limits. Costly routes:

- `/v1/recommend` — requires `ohqs_*` API token (or emergency `ADMIN_TOKEN`)
- `/v1/index/embed` — requires `ai_admin` token, admin Keycloak Bearer JWT, or emergency `ADMIN_TOKEN`

When a client API token is presented on any route, metering + audit apply. `ai_admin` skips metering, still audits.


## Flexprice usage metering (optional, local)

After a successful D1 `api_usage` insert for **client** API tokens, the worker
can POST a usage event to Flexprice sandbox. `ai_admin` is skipped (same as
rate-limit `skipMeter`). Missing `FLEXPRICE_API_KEY` → no-op (API still works).

In `deploy/worker/.dev.vars` (gitignored; copy from `.dev.vars.example`):

```
FLEXPRICE_API_KEY=your-sandbox-key-from-dashboard
# optional overrides:
# FLEXPRICE_API_BASE=https://api.cloud.flexprice.io/v1
# FLEXPRICE_EVENT_NAME=ohqs.api_call
```

Restart wrangler so env loads (`npx wrangler dev --ip 127.0.0.1 --port 8788`).

**Dashboard note:** create a matching metered feature/event name (`ohqs.api_call`
by default) and customers whose `external_customer_id` equals the Keycloak
`user_sub` used as the token owner. OHQS only ingests events; billing setup is
in Flexprice. Never put phones, emails, JWTs, or raw `ohqs_*` tokens in event
properties.

## Explicit policy

**Admin AI tokens must never appear in README examples, CLI defaults, or www.**
Mint/revoke/usage UX lives in openhat-portal only.
