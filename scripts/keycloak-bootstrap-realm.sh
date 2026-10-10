#!/usr/bin/env bash
# Align live Keycloak (openhat realm + openhat-portal client) with the Vercel portal.
# Fixes invalid redirect_uri / post_logout_redirect_uri, default client role,
# superuser composite, and promotes SUPERUSER_EMAIL to realm admin.
#
# Does not print secrets. Requires gcloud SSH to the Keycloak VM.
#
# Usage:
#   ./scripts/keycloak-bootstrap-realm.sh
#   SUPERUSER_EMAIL=you@example.com ./scripts/keycloak-bootstrap-realm.sh

set -euo pipefail

GCP_PROJECT="${GCP_PROJECT:-sandbox420}"
GCP_ZONE="${GCP_ZONE:-us-central1-a}"
GCP_INSTANCE="${GCP_INSTANCE:-openhat-keycloak}"
PORTAL_ORIGIN="${PORTAL_ORIGIN:-https://openhat-website.vercel.app}"
SUPERUSER_EMAIL="${SUPERUSER_EMAIL:-adam@devrecated.com}"

REMOTE=$(cat <<'REMOTE'
set -euo pipefail
cd /opt/openhat/keycloak-gcp
set -a
# shellcheck disable=SC1091
source keycloak.env
set +a
K=/opt/keycloak/bin/kcadm.sh
docker exec openhat-keycloak "$K" config credentials --server http://localhost:8080 --realm master \
  --user "$KC_BOOTSTRAP_ADMIN_USERNAME" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD" >/dev/null

PORTAL_ORIGIN="__PORTAL_ORIGIN__"
SUPERUSER_EMAIL="__SUPERUSER_EMAIL__"

CID=$(docker exec openhat-keycloak "$K" get clients -r openhat -q clientId=openhat-portal --fields id --format csv --noquotes 2>/dev/null | tail -1 | tr -d '\r')
if [[ -z "$CID" || "$CID" == "id" ]]; then
  echo "openhat-portal client not found" >&2
  exit 1
fi

docker exec openhat-keycloak "$K" get "clients/$CID" -r openhat > /tmp/oh-portal-client.json
python3 - "$PORTAL_ORIGIN" <<'PY'
import json, sys
origin = sys.argv[1].rstrip("/")
local = "http://localhost:3210"
path = "/tmp/oh-portal-client.json"
c = json.load(open(path))
c["rootUrl"] = origin
c["baseUrl"] = "/dashboard"
c["redirectUris"] = [
    f"{origin}/api/auth/callback/keycloak",
    f"{origin}/login",
    f"{origin}/",
    f"{origin}/dashboard",
    f"{origin}/dashboard/*",
    f"{origin}/api/auth/*",
    f"{origin}/*",
    f"{local}/api/auth/callback/keycloak",
    f"{local}/*",
]
c["webOrigins"] = [origin, local]
c["standardFlowEnabled"] = True
c["directAccessGrantsEnabled"] = False
c["publicClient"] = False
c["serviceAccountsEnabled"] = True
attrs = dict(c.get("attributes") or {})
attrs["pkce.code.challenge.method"] = "S256"
attrs["post.logout.redirect.uris"] = "##".join([
    f"{origin}/login",
    f"{origin}/",
    f"{origin}/*",
    f"{local}/login",
    f"{local}/*",
])
c["attributes"] = attrs
# Drop secrets / computed fields kcadm rejects on update
for k in ("secret", "id", "protocolMappers"):
    c.pop(k, None)
json.dump(c, open(path, "w"))
PY

docker exec -i openhat-keycloak "$K" update "clients/$CID" -r openhat -f - < /tmp/oh-portal-client.json
rm -f /tmp/oh-portal-client.json

ensure_role() {
  local name="$1"
  if docker exec openhat-keycloak "$K" get "roles/$name" -r openhat >/dev/null 2>&1; then
    return 0
  fi
  docker exec openhat-keycloak "$K" create roles -r openhat -s "name=$name" >/dev/null
}

ensure_role client
ensure_role operator
ensure_role admin
ensure_role superuser

docker exec openhat-keycloak "$K" add-roles -r openhat --rname superuser --rolename admin --rolename operator --rolename client 2>/dev/null || true
docker exec openhat-keycloak "$K" add-roles -r openhat --rname default-roles-openhat --rolename client 2>/dev/null || true

# Service account can invite/promote users from the portal.
docker exec openhat-keycloak "$K" add-roles -r openhat \
  --uusername service-account-openhat-portal \
  --cclientid realm-management \
  --rolename manage-users --rolename view-users --rolename query-users \
  --rolename view-realm --rolename query-groups --rolename manage-realm 2>/dev/null || true

promote() {
  local email="$1"
  local json
  json=$(docker exec openhat-keycloak "$K" get users -r openhat -q "email=$email" --fields id,username,email --format json)
  local id
  id=$(python3 -c 'import json,sys; u=json.load(sys.stdin); print(u[0]["id"] if u else "")' <<<"$json")
  if [[ -z "$id" ]]; then
    echo "no user with email $email — skipping promote"
    return 0
  fi
  docker exec openhat-keycloak "$K" update "users/$id" -r openhat -s emailVerified=true -s enabled=true >/dev/null
  local uname
  uname=$(python3 -c 'import json,sys; u=json.load(sys.stdin); print(u[0].get("username") or "")' <<<"$json")
  docker exec openhat-keycloak "$K" add-roles -r openhat --uusername "$uname" \
    --rolename superuser --rolename admin --rolename operator --rolename client
  docker exec openhat-keycloak "$K" add-roles -r openhat --uusername "$uname" \
    --cclientid realm-management --rolename realm-admin
  echo "promoted $email ($uname) to superuser + realm-admin"
}

promote "$SUPERUSER_EMAIL"
# Typo the dashboard request used; promote if that account exists too.
if [[ "$SUPERUSER_EMAIL" != "adam@devrecatred.com" ]]; then
  promote adam@devrecatred.com || true
fi

echo "ok: redirect + post-logout URIs set for $PORTAL_ORIGIN"
REMOTE
)

REMOTE="${REMOTE//__PORTAL_ORIGIN__/$PORTAL_ORIGIN}"
REMOTE="${REMOTE//__SUPERUSER_EMAIL__/$SUPERUSER_EMAIL}"

gcloud compute ssh "$GCP_INSTANCE" --zone="$GCP_ZONE" --project="$GCP_PROJECT" \
  --command="sudo bash -lc $(printf '%q' "$REMOTE")"
