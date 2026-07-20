#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${1:?domain is required}"
RELEASE_ARCHIVE="${2:-/tmp/atoms-demo-release.tgz}"
KEY_FILE="${3:-/tmp/deepseek.key}"
RESET_WORKSPACE="${4:-0}"
DEVICE="/dev/disk/by-id/google-atoms-workspace"
MOUNT_POINT="/workspace"
RELEASE_ROOT="/opt/atoms-demo/releases"
RELEASE_ID="$(date -u +%Y%m%d%H%M%S)"
RELEASE_DIR="${RELEASE_ROOT}/${RELEASE_ID}"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y \
  apparmor \
  bubblewrap \
  build-essential \
  ca-certificates \
  caddy \
  curl \
  fontconfig \
  fonts-noto-cjk \
  fonts-noto-color-emoji \
  git \
  gnupg

if [ ! -f /etc/apt/sources.list.d/google-chrome.list ]; then
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
    | gpg --batch --yes --dearmor -o /etc/apt/keyrings/google-chrome.gpg
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list
fi
apt-get update
apt-get install -y google-chrome-stable
# The screenshot process runs inside the existing bubblewrap filesystem,
# which exposes /usr but deliberately not the rest of /opt.
mkdir -p /usr/lib/atoms-chrome
cp -a /opt/google/chrome/. /usr/lib/atoms-chrome/

if ! command -v node >/dev/null || [ "$(node -p 'Number(process.versions.node.split(`.`)[0])')" -lt 22 ]; then
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --batch --yes --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update
  apt-get install -y nodejs
fi

if ! id atoms >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/atoms-demo --shell /usr/sbin/nologin atoms
fi

if ! blkid "${DEVICE}" >/dev/null 2>&1; then
  mkfs.ext4 -F "${DEVICE}"
fi
mkdir -p "${MOUNT_POINT}"
if ! grep -q "${DEVICE}" /etc/fstab; then
  echo "${DEVICE} ${MOUNT_POINT} ext4 defaults,nofail,discard 0 2" >> /etc/fstab
fi
mount "${MOUNT_POINT}" || true
chown atoms:atoms "${MOUNT_POINT}"
chmod 0750 "${MOUNT_POINT}"
if [ "${RESET_WORKSPACE}" = "1" ]; then
  find "${MOUNT_POINT}" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
fi

mkdir -p "${RELEASE_DIR}" /etc/atoms-demo
tar -xzf "${RELEASE_ARCHIVE}" -C "${RELEASE_DIR}"
chown -R root:root "${RELEASE_DIR}"
cd "${RELEASE_DIR}"

# Ubuntu 24.04 restricts unprofiled user namespaces. Allow bubblewrap itself to
# create the namespace used by the project command sandbox without weakening
# the host-wide setting.
install -m 0644 infra/apparmor/usr.bin.bwrap /etc/apparmor.d/usr.bin.bwrap
apparmor_parser -r /etc/apparmor.d/usr.bin.bwrap

npm ci --omit=dev
mkdir -p dist

install -m 0600 -o atoms -g atoms "${KEY_FILE}" /etc/atoms-demo/deepseek.key
sed "s/__DOMAIN__/${DOMAIN}/g" infra/systemd/atoms-demo.service \
  > /etc/systemd/system/atoms-demo.service
chmod 0644 /etc/systemd/system/atoms-demo.service
sed "s/__DOMAIN__/${DOMAIN}/g" infra/Caddyfile.template > /etc/caddy/Caddyfile

mkdir -p /opt/atoms-demo
ln -sfn "${RELEASE_DIR}" /opt/atoms-demo/current
systemctl daemon-reload
systemctl enable --now atoms-demo
systemctl restart atoms-demo
caddy validate --config /etc/caddy/Caddyfile
systemctl enable caddy
systemctl restart caddy

curl --fail --silent --show-error \
  --retry 20 --retry-delay 2 --retry-connrefused \
  http://127.0.0.1:8080/api/health
