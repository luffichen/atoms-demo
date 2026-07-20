#!/usr/bin/env bash
set -euo pipefail

PROJECT="${GCLOUD_PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
ZONE="${GCLOUD_ZONE:-asia-east1-b}"
REGION="${GCLOUD_REGION:-${ZONE%-*}}"
INSTANCE="${GCLOUD_INSTANCE:-atoms-demo}"
DISK="${GCLOUD_DISK:-atoms-demo-workspace}"
ADDRESS_NAME="${GCLOUD_ADDRESS:-atoms-demo-ip}"
MACHINE_TYPE="${GCLOUD_MACHINE_TYPE:-e2-standard-4}"
DISK_SIZE="${GCLOUD_DISK_SIZE:-100GB}"
KEY_FILE="${DEEPSEEK_KEY_FILE:-docs/deepseek.key}"
RESET_WORKSPACE="${ATOMS_RESET_WORKSPACE:-0}"
ARCHIVE="/tmp/atoms-demo-release.tgz"

if [ -z "${PROJECT}" ] || [ "${PROJECT}" = "(unset)" ]; then
  echo "GCLOUD_PROJECT is required" >&2
  exit 1
fi
if [ ! -s "${KEY_FILE}" ]; then
  echo "DeepSeek key file not found or empty: ${KEY_FILE}" >&2
  exit 1
fi

npm run test:coverage
npm run typecheck
npm run build

gcloud services enable compute.googleapis.com --project "${PROJECT}"

if ! gcloud compute addresses describe "${ADDRESS_NAME}" --region "${REGION}" --project "${PROJECT}" >/dev/null 2>&1; then
  gcloud compute addresses create "${ADDRESS_NAME}" \
    --project "${PROJECT}" --region "${REGION}" --network-tier PREMIUM
fi
EXTERNAL_IP="$(gcloud compute addresses describe "${ADDRESS_NAME}" \
  --project "${PROJECT}" --region "${REGION}" --format='value(address)')"

if ! gcloud compute disks describe "${DISK}" --zone "${ZONE}" --project "${PROJECT}" >/dev/null 2>&1; then
  gcloud compute disks create "${DISK}" \
    --project "${PROJECT}" --zone "${ZONE}" --size "${DISK_SIZE}" --type pd-balanced
fi

if ! gcloud compute instances describe "${INSTANCE}" --zone "${ZONE}" --project "${PROJECT}" >/dev/null 2>&1; then
  gcloud compute instances create "${INSTANCE}" \
    --project "${PROJECT}" \
    --zone "${ZONE}" \
    --machine-type "${MACHINE_TYPE}" \
    --image-family ubuntu-2404-lts-amd64 \
    --image-project ubuntu-os-cloud \
    --boot-disk-size 30GB \
    --address "${EXTERNAL_IP}" \
    --no-service-account \
    --no-scopes \
    --disk "name=${DISK},device-name=atoms-workspace,mode=rw,boot=no" \
    --tags atoms-demo-http
fi

if ! gcloud compute firewall-rules describe atoms-demo-web --project "${PROJECT}" >/dev/null 2>&1; then
  gcloud compute firewall-rules create atoms-demo-web \
    --project "${PROJECT}" \
    --allow tcp:80,tcp:443 \
    --target-tags atoms-demo-http \
    --description "Public HTTPS for Atoms Demo"
fi

DOMAIN="${ATOMS_DOMAIN:-${EXTERNAL_IP}.sslip.io}"

tar -czf "${ARCHIVE}" \
  --exclude=node_modules \
  --exclude=workspace \
  --exclude=data \
  --exclude=coverage \
  --exclude=.git \
  --exclude=deepseek.key \
  --exclude=docs/deepseek.key \
  .

gcloud compute scp "${ARCHIVE}" "${KEY_FILE}" infra/provision.sh \
  "${INSTANCE}:/tmp/" --project "${PROJECT}" --zone "${ZONE}"
gcloud compute ssh "${INSTANCE}" \
  --project "${PROJECT}" --zone "${ZONE}" \
  --command "sudo bash /tmp/provision.sh '${DOMAIN}' /tmp/atoms-demo-release.tgz /tmp/$(basename "${KEY_FILE}") '${RESET_WORKSPACE}'"

for attempt in $(seq 1 30); do
  if curl --fail --silent --show-error --max-time 5 "https://${DOMAIN}/api/health" >/dev/null; then
    break
  fi
  if [ "${attempt}" -eq 30 ]; then
    echo "Public HTTPS health check failed: https://${DOMAIN}/api/health" >&2
    exit 1
  fi
  sleep 2
done

node scripts/verify-deployment.mjs "https://${DOMAIN}"

echo "https://${DOMAIN}"
