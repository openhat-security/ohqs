# Keycloak on GCP (sandbox420)

Small VM (`e2-small`) + Docker: Postgres, Keycloak 26, Caddy (Let's Encrypt).

## Deploy

```bash
export GCP_PROJECT=sandbox420
# Real domain (recommended):
# export KEYCLOAK_PUBLIC_HOST=auth.yourdomain.com
# Quick test (no DNS): omit KEYCLOAK_PUBLIC_HOST — script uses <static-ip>.sslip.io

make deploy-keycloak
# or: ./scripts/gcp-deploy-keycloak.sh
```

**Sandbox420 (live):** static IP `136.71.1.161`, host `136.71.1.161.sslip.io`, issuer  
`https://136.71.1.161.sslip.io/realms/openhat` (realm + `openhat-portal` client bootstrapped on VM).

Admin password: on the VM only:

```bash
gcloud compute ssh openhat-keycloak --zone=us-central1-a --project=sandbox420 \
  --command='sudo grep KC_BOOTSTRAP_ADMIN_PASSWORD /opt/openhat/keycloak-gcp/keycloak.env'
```

Master-realm `/admin` uses that bootstrap admin. Day-to-day role promotions use `realm-admin` on the openhat user (see bootstrap).

## Realm bootstrap (once)

```bash
make bootstrap-keycloak
# SUPERUSER_EMAIL=you@example.com make bootstrap-keycloak
```

That sets portal redirect + **post-logout** URIs (sign-out fails with `invalid_redirect_uri` if post-logout is empty), default role `client` for new users, composite `superuser`, and promotes `SUPERUSER_EMAIL` to `superuser` + `realm-admin` so they can assign roles in the Keycloak console:

`https://136.71.1.161.sslip.io/admin/openhat/console/` (sign in with the **openhat** realm user, not master).

Manual equivalent (Admin Console → realm **`openhat`**):

1. **Realm settings → Login**: Registration allowed; email as username.
2. **Realm roles**: `client`, `operator`, `admin`, `superuser` (composite of the first three). Default composite for new users includes `client`.
3. **Client `openhat-portal`**: confidential, standard flow, PKCE.
   - Redirect: `https://openhat-website.vercel.app/api/auth/callback/keycloak` and `https://openhat-website.vercel.app/*`
   - Web origins: `https://openhat-website.vercel.app`
   - Post-logout: `https://openhat-website.vercel.app/login` and `https://openhat-website.vercel.app/*`
4. **Mapper**: client scope / protocol mapper `roles` on ID token + userinfo (see `docs/auth-keycloak.md`).
5. Copy client secret → Vercel `KEYCLOAK_CLIENT_SECRET`.
6. **Authentication → Required actions**: disable **Verify profile** / **Update profile** as default (otherwise OIDC login stalls on “Update Account Information” before returning to the portal).

## Downstream env

| Where | Variable | Value |
|-------|----------|--------|
| Vercel `openhat-website` | `KEYCLOAK_ISSUER` | `https://<host>/realms/openhat` |
| Vercel | `KEYCLOAK_CLIENT_ID` | `openhat-portal` |
| Vercel | `KEYCLOAK_CLIENT_SECRET` | from Keycloak |
| Vercel | `AUTH_URL` / `NEXTAUTH_URL` | `https://openhat-website.vercel.app` |
| Vercel | `AUTH_SECRET` | `openssl rand -base64 32` |
| Cloudflare Worker | `KEYCLOAK_ISSUER` | same issuer (JWKS mint path) |

## Local laptop → this VM (not Docker on the laptop)

`localhost:8080` on the laptop is often some other app. Do not start
`openhat-www` `docker compose` Keycloak.

```bash
make keycloak-tunnel
# http://127.0.0.1:18090  →  openhat-keycloak container :8080
```

Portal OIDC must still use `KEYCLOAK_ISSUER=https://136.71.1.161.sslip.io/realms/openhat`
because the VM Keycloak is hostname-strict.

## Ops

```bash
gcloud compute ssh openhat-keycloak --zone=us-central1-a --project=sandbox420
cd /opt/openhat/keycloak-gcp && sudo docker compose ps
sudo docker compose logs -f keycloak
```

Rotate secrets in `keycloak.env`, then `docker compose up -d`.
