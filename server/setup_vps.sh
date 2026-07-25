#!/usr/bin/env bash
set -euo pipefail

if [ "${EUID}" -ne 0 ]; then
  echo "Hãy chạy: sudo bash setup_vps.sh"
  exit 1
fi

ask_yes_no() {
  local prompt="$1"
  local default="$2"
  local answer
  while true; do
    read -r -p "${prompt} [${default}]: " answer
    answer="${answer:-${default}}"
    case "${answer,,}" in
      y|yes|c|co|có) return 0 ;;
      n|no|k|khong|không) return 1 ;;
      *) echo "Nhập y hoặc n." ;;
    esac
  done
}

echo
echo "RustDesk Kiosk · Setup VPS chat/dashboard"
echo

ENV_FILE="/etc/rustdesk-kiosk-chat.env"
ADMIN_PASSWORD=""
RESET_PASSWORD=0
if [ ! -f "${ENV_FILE}" ] || ! grep -q '^ADMIN_PASSWORD_HASH=' "${ENV_FILE}"; then
  RESET_PASSWORD=1
elif ask_yes_no "Đổi mật khẩu admin?" "n"; then
  RESET_PASSWORD=1
fi

if [ "${RESET_PASSWORD}" = "1" ]; then
  read -r -s -p "Mật khẩu admin mới (ít nhất 10 ký tự): " ADMIN_PASSWORD
  echo
  read -r -s -p "Nhập lại mật khẩu: " ADMIN_PASSWORD_CONFIRM
  echo
  if [ "${ADMIN_PASSWORD}" != "${ADMIN_PASSWORD_CONFIRM}" ]; then
    echo "Hai mật khẩu không khớp."
    exit 1
  fi
  if [ "${#ADMIN_PASSWORD}" -lt 10 ]; then
    echo "Mật khẩu phải có ít nhất 10 ký tự."
    exit 1
  fi
  export ADMIN_PASSWORD
  unset ADMIN_PASSWORD_CONFIRM
fi

if ask_yes_no "Bật backup Google Drive lúc 00:00 mỗi ngày?" "n"; then
  export ENABLE_BACKUP=1
else
  export ENABLE_BACKUP=0
fi

export APP_PORT=3000
export BACKUP_CRON="0 0 * * *"
export RCLONE_REMOTE="gdrive:rustdesk-kiosk-backups"
export RETENTION_DAYS=7
export MANAGE_FIREWALL=1

timedatectl set-timezone Asia/Ho_Chi_Minh
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
"${SCRIPT_DIR}/deploy_chat_only.sh"
unset ADMIN_PASSWORD

if [ "${ENABLE_BACKUP}" = "1" ] && ! rclone listremotes | grep -Fxq 'gdrive:'; then
  echo
  echo "Backup đã bật nhưng Google Drive chưa liên kết."
  echo "Khi cần, chạy: sudo rclone config"
fi
