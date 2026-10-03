#!/usr/bin/env bash
# Provision (or update) a small GCE VM running Keycloak for openhat-portal / Worker JWKS.
#
# Usage:
#   export KEYCLOAK_PUBLIC_HOST='auth.YOUR_DOMAIN'   # DNS A → static IP before TLS works
#   # quick test with nip.io after IP is known:
#   #   export KEYCLOAK_PUBLIC_HOST='34.x.x.x.nip.io'
#   ./scripts/gcp-deploy-keycloak.sh
#
# Options:
#   GCP_PROJECT=sandbox420  GCP_ZONE=us-central1-a  GCP_INSTANCE=openhat-keycloak
#   --host-only             print static IP + issuer URL, do not recreate VM
#
# After deploy: configure realm `openhat` + client `openhat-portal` (see deploy/keycloak-gcp/README.md)
# Vercel: KEYCLOAK_ISSUER=https://$KEYCLOAK_PUBLIC_HOST/realms/openhat
# Worker: wrangler secret put KEYCLOAK_ISSUER

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KC_DIR="$ROOT/deploy/keycloak-gcp"

GCP_PROJECT="${GCP_PROJECT:-sandbox420}"
GCP_ZONE="${GCP_ZONE:-us-central1-a}"
GCP_INSTANCE="${GCP_INSTANCE:-openhat-keycloak}"
GCP_MACHINE_TYPE="${GCP_MACHINE_TYPE:-e2-small}"
HOST_ONLY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host-only) HOST_ONLY=true; shift ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown: $1" >&2; exit 1 ;;
  esac
done

gcloud config set project "$GCP_PROJECT" >/dev/null

ADDR_NAME="${GCP_INSTANCE}-ip"
if ! gcloud compute addresses describe "$ADDR_NAME" --region="${GCP_ZONE%-*}" >/dev/null 2>&1; then
  echo "== reserve regional static IP: $ADDR_NAME"
  gcloud compute addresses create "$ADDR_NAME" --region="${GCP_ZONE%-*}"
fi
STATIC_IP="$(gcloud compute addresses describe "$ADDR_NAME" --region="${GCP_ZONE%-*}" --format='get(address)')"
echo "== static IP: $STATIC_IP"

if [[ -z "${KEYCLOAK_PUBLIC_HOST:-}" ]]; then
  KEYCLOAK_PUBLIC_HOST="${STATIC_IP}.sslip.io"
  echo "== KEYCLOAK_PUBLIC_HOST not set; using $KEYCLOAK_PUBLIC_HOST (set DNS or export KEYCLOAK_PUBLIC_HOST for a real domain)"
fi

ISSUER="https://${KEYCLOAK_PUBLIC_HOST}/realms/openhat"
echo "== target issuer (after realm import): $ISSUER"

if [[ "$HOST_ONLY" == true ]]; then
  echo "Point DNS A/AAAA for your auth host to $STATIC_IP"
  exit 0
fi

if ! gcloud compute firewall-rules describe openhat-keycloak-http >/dev/null 2>&1; then
  echo "== firewall: 22, 80, 443"
  gcloud compute firewall-rules create openhat-keycloak-http \
    --allow=tcp:22,tcp:80,tcp:443 \
    --target-tags=openhat-keycloak \
    --description="OpenHat Keycloak VM"
fi

# Pack stack files for startup (no secrets)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cp "$KC_DIR/docker-compose.yml" "$KC_DIR/Caddyfile" "$KC_DIR/vm-startup.sh" "$TMP/"
tar -C "$TMP" -czf "$TMP/stack.tgz" docker-compose.yml Caddyfile vm-startup.sh

STARTUP="$TMP/combined-startup.sh"
cat > "$STARTUP" << 'BOOT'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p /opt/openhat/keycloak-gcp
cd /opt/openhat/keycloak-gcp
curl -sf -H "Metadata-Flavor: Google" \
  "http://metadata.google.internal/computeMetadata/v1/instance/attributes/stack-tgz" \
  | base64 -d | tar -xzf -
chmod +x vm-startup.sh
exec ./vm-startup.sh
BOOT
chmod +x "$STARTUP"

STACK_B64="$(base64 < "$TMP/stack.tgz" | tr -d '\n')"

if gcloud compute instances describe "$GCP_INSTANCE" --zone="$GCP_ZONE" >/dev/null 2>&1; then
  echo "== instance $GCP_INSTANCE exists — updating metadata and restarting"
  gcloud compute instances add-metadata "$GCP_INSTANCE" --zone="$GCP_ZONE" \
    --metadata="keycloak-public-host=${KEYCLOAK_PUBLIC_HOST},stack-tgz=${STACK_B64}"
  gcloud compute instances reset "$GCP_INSTANCE" --zone="$GCP_ZONE"
else
  echo "== create VM $GCP_INSTANCE ($GCP_MACHINE_TYPE)"
  gcloud compute instances create "$GCP_INSTANCE" \
    --zone="$GCP_ZONE" \
    --machine-type="$GCP_MACHINE_TYPE" \
    --tags=openhat-keycloak \
    --address="$STATIC_IP" \
    --image-family=debian-12 \
    --image-project=debian-cloud \
    --boot-disk-size=20GB \
    --metadata="keycloak-public-host=${KEYCLOAK_PUBLIC_HOST},stack-tgz=${STACK_B64}" \
    --metadata-from-file=startup-script="$STARTUP" \
    --scopes=cloud-platform
fi

echo ""
echo "== waiting for Keycloak HTTPS (up to ~5 min)"
for i in $(seq 1 30); do
  if curl -sfk "https://${KEYCLOAK_PUBLIC_HOST}/realms/master" >/dev/null 2>&1; then
    echo "ok: Keycloak responding at https://${KEYCLOAK_PUBLIC_HOST}"
    break
  fi
  sleep 10
  if [[ "$i" -eq 30 ]]; then
    echo "warn: Keycloak not up yet — SSH: gcloud compute ssh $GCP_INSTANCE --zone=$GCP_ZONE"
    echo "      logs: sudo docker compose -f /opt/openhat/keycloak-gcp/docker-compose.yml logs -f"
  fi
done

cat <<EOF

Next (once):
  1. DNS: $KEYCLOAK_PUBLIC_HOST → $STATIC_IP (sslip.io works without DNS if you used default host)
  2. SSH admin console: https://${KEYCLOAK_PUBLIC_HOST}/admin  (password in /opt/openhat/keycloak-gcp/keycloak.env on VM)
  3. Create realm openhat + client openhat-portal — deploy/keycloak-gcp/README.md
  4. Vercel (openhat-website): KEYCLOAK_ISSUER=$ISSUER, KEYCLOAK_CLIENT_ID, KEYCLOAK_CLIENT_SECRET, AUTH_SECRET, AUTH_URL=https://openhat-website.vercel.app
  5. Worker: npx wrangler secret put KEYCLOAK_ISSUER  # $ISSUER

EOF
