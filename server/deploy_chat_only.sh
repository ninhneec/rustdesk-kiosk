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
apt-get install -y curl git openssl ufw sqlite3 rclone
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
  CHAT_SESSION_SECRET="$(openssl rand -hex 48)"
  umask 077
  cat > "${ENV_FILE}" <<EOF
CHAT_SESSION_SECRET=${CHAT_SESSION_SECRET}
DATABASE_PATH=${DATA_DIR}/devices.db
PORT=3000
NODE_ENV=production
RCLONE_REMOTE=gdrive:rustdesk-kiosk-backups
EOF
  chmod 600 "${ENV_FILE}"
  echo "Đã tạo cấu hình mới tại ${ENV_FILE}"
else
  sed -i '/^ADMIN_TOKEN=/d' "${ENV_FILE}"
  echo "Giữ nguyên secret hiện có và đã loại bỏ ADMIN_TOKEN"
fi

if [ -n "${ADMIN_PASSWORD:-}" ] || ! grep -q '^ADMIN_PASSWORD_HASH=' "${ENV_FILE}"; then
  if [ -z "${ADMIN_PASSWORD:-}" ]; then
    if [ ! -t 0 ]; then
      echo "Thiếu mật khẩu. Chạy lại với: sudo ADMIN_PASSWORD='mat-khau-cua-ban' bash deploy_chat_only.sh"
      exit 1
    fi
    read -r -s -p "Đặt mật khẩu quản trị: " ADMIN_PASSWORD
    echo
    read -r -s -p "Nhập lại mật khẩu: " ADMIN_PASSWORD_CONFIRM
    echo
    if [ "${ADMIN_PASSWORD}" != "${ADMIN_PASSWORD_CONFIRM}" ]; then
      echo "Hai mật khẩu không khớp"
      exit 1
    fi
  fi
  if [ "${#ADMIN_PASSWORD}" -lt 10 ]; then
    echo "Mật khẩu quản trị phải có ít nhất 10 ký tự"
    exit 1
  fi
  ADMIN_PASSWORD_HASH="$(ADMIN_PASSWORD="${ADMIN_PASSWORD}" node -e "const c=require('crypto');const s=c.randomBytes(16);const h=c.scryptSync(process.env.ADMIN_PASSWORD,s,32);process.stdout.write(['scrypt',s.toString('base64url'),h.toString('base64url')].join(':'))")"
  sed -i '/^ADMIN_PASSWORD_HASH=/d' "${ENV_FILE}"
  printf 'ADMIN_PASSWORD_HASH=%s\n' "${ADMIN_PASSWORD_HASH}" >> "${ENV_FILE}"
  unset ADMIN_PASSWORD ADMIN_PASSWORD_CONFIRM ADMIN_PASSWORD_HASH
else
  STORED_PASSWORD_HASH="$(sed -n 's/^ADMIN_PASSWORD_HASH=//p' "${ENV_FILE}")"
  if [[ "${STORED_PASSWORD_HASH}" == scrypt\$*\$* ]]; then
    NORMALIZED_PASSWORD_HASH="${STORED_PASSWORD_HASH//\$/\:}"
    sed -i '/^ADMIN_PASSWORD_HASH=/d' "${ENV_FILE}"
    printf 'ADMIN_PASSWORD_HASH=%s\n' "${NORMALIZED_PASSWORD_HASH}" >> "${ENV_FILE}"
  fi
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

install -m 750 "${SERVER_DIR}/backup_to_gdrive.sh" /usr/local/sbin/rustdesk-kiosk-backup
cat > /etc/cron.d/rustdesk-kiosk-backup <<'EOF'
17 2 * * * root set -a; . /etc/rustdesk-kiosk-chat.env; set +a; /usr/local/sbin/rustdesk-kiosk-backup >> /var/log/rustdesk-kiosk-backup.log 2>&1
EOF
chmod 644 /etc/cron.d/rustdesk-kiosk-backup

echo "[5/5] Cấu hình tường lửa"
ufw allow 22/tcp
ufw allow 3000/tcp
ufw --force enable

echo "Hoàn tất. Dashboard: http://<IP_VPS>:3000"
echo "Dashboard dùng mật khẩu quản trị bạn đã đặt; không còn ADMIN_TOKEN."
echo "Để bật backup Google Drive: sudo rclone config (tạo remote tên gdrive), rồi chạy sudo /usr/local/sbin/rustdesk-kiosk-backup"
echo "Khuyến nghị đặt port 3000 sau reverse proxy HTTPS và chỉ mở 80/443."
