# OHQS auth (Keycloak + API tokens)

Local-first auth for OpenHat Quick Start. Reuses the existing Keycloak realm
`openhat` (same Docker stack as openhat-portal). Uses a **separate** confidential
client `ohqs-api` — do **not** reuse `openhat-portal`.

## Pieces

| Piece | Purpose |
|-------|---------|
| Keycloak realm `openhat` | Users + realm roles (`client`, `operator`, `admin`) |
| Client `ohqs-api` | Confidential OIDC client for OHQS console/API |
| Opaque API tokens | Minted by the Worker after a Keycloak session; hashed at rest |
| Durable Object rate limiter | Keys `token:${token_id}` (+ IP) for `client` tokens |
| D1 `api_tokens` / `api_usage` | Token metadata + per-call audit |

## Token types

1. **Client API token** (`type=client`, prefix `ohqs_c_…`)
   - Any authenticated OHQS user (Keycloak session) may mint via `POST /v1/tokens`.
   - Metered via the existing DO rate limiter keyed by `token:${token_id}` and IP.
   - Every authenticated call is audited: token_id, user_sub, route, method, IP, UA, status, bytes, ts.
   - **Only a SHA-256 hash is stored** — raw token shown once at mint.

2. **Admin AI token** (`type=ai_admin`, prefix `ohqs_a_…`)
   - Only realm role `admin` may mint (`POST /v1/tokens/ai` or `POST /v1/tokens` with `{ "type": "ai_admin" }`).
   - **No client rate limits**, but every use is still audited.
   - **Never** embed in CLI defaults, README examples, or www.
   - Rotate/revoke via `POST /v1/tokens/:id/revoke`.

Clients cannot mint AI tokens. OHQS self-serve signup (`POST /v1/auth/signup`) creates a Keycloak user with realm role `client` — separate from the invite-only engagement portal.

## Keycloak client `ohqs-api`

Expected settings (local):

- Client authentication: **On** (confidential)
- Standard flow: **On**
- **Direct Access Grants: Off**
- Service accounts: **On** (self-serve signup via Admin API)
- Valid redirect URIs: `http://localhost:8787/*`, `http://127.0.0.1:8787/*` (and `:8788` if needed)
- Web origins: matching console origins
- Protocol mapper `realm-roles` → claim `roles` (ID + access + userinfo), like portal

Issuer: `http://localhost:8080/realms/openhat`

## Local env

```bash
cd deploy/worker
cp .dev.vars.example .dev.vars
# Fill KEYCLOAK_CLIENT_SECRET from Keycloak → Clients → ohqs-api → Credentials
```

`.dev.vars` is gitignored. Never commit secrets or real passwords.

```
KEYCLOAK_ISSUER=http://localhost:8080/realms/openhat
KEYCLOAK_CLIENT_ID=ohqs-api
KEYCLOAK_CLIENT_SECRET=…
# Optional emergency local-only embed gate — prefer ai_admin token instead:
# ADMIN_TOKEN=
```

## Run locally

1. Start Keycloak (from openhat-portal): `npm run keycloak:up` → http://localhost:8080
2. Apply D1 migrations:

```bash
cd deploy/worker
npx wrangler d1 migrations apply ohqs --local
```

3. Dev worker (+ console assets on same origin):

```bash
npx wrangler dev
# → http://127.0.0.1:8787
# If 8787 is already taken (e.g. local Go UI), use:
# npx wrangler dev --ip 127.0.0.1 --port 8788
# (ohqs-api redirects already allow :8788)
```

4. Open the console → **Account** tab:
   - Signup (optional) → Login with Keycloak → Mint client token
   - Admins see **Mint admin AI token**

OIDC flow: console → `GET /v1/auth/login` → Keycloak → `GET /v1/auth/callback` → redirect back with access token in the URL hash (local only).

## API surface (auth)

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | `/v1/auth/signup` | none | Self-serve Keycloak user + role `client` |
| GET | `/v1/auth/login` | none | Start OIDC (PKCE) |
| GET | `/v1/auth/callback` | none | OIDC code exchange |
| GET | `/v1/auth/verify` | Bearer KC or API token | Session/token introspection |
| POST | `/v1/tokens` | Keycloak access token | Mint `client` (or `ai_admin` if admin) |
| POST | `/v1/tokens/ai` | Keycloak + role `admin` | Mint `ai_admin` |
| GET | `/v1/tokens` | Keycloak | List own tokens (prefix/type/dates; never hash/raw) |
| POST | `/v1/tokens/:id/revoke` | Keycloak | Revoke |
| GET | `/v1/usage` | Keycloak | Own usage summary |

Public catalog reads (`/v1/search`, `/v1/bounties`, `/v1/models`, `/v1/index`, `/v1/tools/*`, `/v1/llm/models`) stay public with IP rate limits. Costly routes:

- `/v1/recommend` — requires API token or Keycloak session
- `/v1/index/embed` — requires `ai_admin` token, admin Keycloak session, or emergency `ADMIN_TOKEN`

When a client API token is presented on any route, metering + audit apply. `ai_admin` skips metering, still audits.

## Explicit policy

**Admin AI tokens must never appear in README examples, CLI defaults, or www.**
