#!/usr/bin/env bash
# GCE startup: Docker + Keycloak stack under /opt/openhat/keycloak-gcp
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg openssl

if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi

mkdir -p /opt/openhat/keycloak-gcp
cd /opt/openhat/keycloak-gcp

MD_HOST="$(curl -sf -H "Metadata-Flavor: Google" \
  http://metadata.google.internal/computeMetadata/v1/instance/attributes/keycloak-public-host || true)"

if [[ -z "$MD_HOST" ]]; then
  echo "keycloak-public-host metadata missing" >&2
  exit 1
fi

if [[ ! -f keycloak.env ]]; then
  pg="$(openssl rand -hex 24)"
  kc="$(openssl rand -hex 16)"
  {
    echo "KEYCLOAK_PUBLIC_HOST=${MD_HOST}"
    echo "POSTGRES_PASSWORD=${pg}"
    echo "KC_DB_PASSWORD=${pg}"
    echo "KC_BOOTSTRAP_ADMIN_USERNAME=admin"
    echo "KC_BOOTSTRAP_ADMIN_PASSWORD=${kc}"
  } > keycloak.env
  chmod 600 keycloak.env
fi

set -a
# shellcheck disable=SC1091
source keycloak.env
set +a

if [[ ! -f docker-compose.yml ]]; then
  echo "stack files missing — re-run gcp-deploy-keycloak.sh" >&2
  exit 1
fi

docker compose pull
docker compose up -d
