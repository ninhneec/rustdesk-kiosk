#!/usr/bin/env bash
set -euo pipefail

# Deploy only the independent chat/dashboard service. RustDesk remote traffic
# continues to use the public RustDesk infrastructure configured in the client.
if [ "${EUID}" -ne 0 ]; then
  echo "Vui lòng chạy bằng quyền root: sudo ./deploy_chat_only.sh"
  exit 1
fi

REPO_DIR="/opt/rustdesk-kiosk"
SERVER_DIR="${REPO_DIR}/server"
DATA_DIR="/var/lib/rustdesk-kiosk-chat"
ENV_FILE="/etc/rustdesk-kiosk-chat.env"

echo "[1/5] Cài Node.js và công cụ triển khai"
apt-get update
apt-get install -y curl git openssl ufw
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
if ! command -v pm2 >/dev/null 2>&1; then
  npm install --global pm2
fi

echo "[2/5] Đồng bộ mã nguồn"
if [ -d "${REPO_DIR}/.git" ]; then
  git -C "${REPO_DIR}" fetch origin master
  git -C "${REPO_DIR}" pull --ff-only origin master
else
  git clone https://github.com/ninhneec/rustdesk-kiosk.git "${REPO_DIR}"
fi

echo "[3/5] Chuẩn bị dữ liệu và secret bền vững"
install -d -m 750 "${DATA_DIR}"
if [ ! -f "${ENV_FILE}" ]; then
  ADMIN_TOKEN="$(openssl rand -hex 32)"
  CHAT_SESSION_SECRET="$(openssl rand -hex 48)"
  umask 077
  cat > "${ENV_FILE}" <<EOF
ADMIN_TOKEN=${ADMIN_TOKEN}
CHAT_SESSION_SECRET=${CHAT_SESSION_SECRET}
DATABASE_PATH=${DATA_DIR}/devices.db
PORT=3000
NODE_ENV=production
EOF
  chmod 600 "${ENV_FILE}"
  echo "Đã tạo secret mới tại ${ENV_FILE}"
else
  echo "Giữ nguyên secret hiện có tại ${ENV_FILE}"
fi

echo "[4/5] Cài dependency và khởi động bằng PM2"
cd "${SERVER_DIR}"
npm ci --omit=dev
set -a
# shellcheck disable=SC1090
. "${ENV_FILE}"
set +a
pm2 delete kiosk-chat >/dev/null 2>&1 || true
pm2 start index.js --name kiosk-chat --update-env
pm2 save
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true

echo "[5/5] Cấu hình tường lửa"
ufw allow 22/tcp
ufw allow 3000/tcp
ufw --force enable

echo "Hoàn tất. Dashboard: http://<IP_VPS>:3000"
echo "ADMIN_TOKEN: $(sed -n 's/^ADMIN_TOKEN=//p' "${ENV_FILE}")"
echo "Khuyến nghị đặt port 3000 sau reverse proxy HTTPS và chỉ mở 80/443."
