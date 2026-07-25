#!/usr/bin/env bash
set -u

ENV_FILE="/etc/rustdesk-kiosk-chat.env"
DATABASE_PATH="/var/lib/rustdesk-kiosk-chat/devices.db"
PORT="3000"

if [ -f "${ENV_FILE}" ]; then
  PORT="$(sed -n 's/^PORT=//p' "${ENV_FILE}" | tail -n 1)"
  DATABASE_PATH="$(sed -n 's/^DATABASE_PATH=//p' "${ENV_FILE}" | tail -n 1)"
  PORT="${PORT:-3000}"
  DATABASE_PATH="${DATABASE_PATH:-/var/lib/rustdesk-kiosk-chat/devices.db}"
fi

section() {
  echo
  echo "=== $1 ==="
}

ok_or_fail() {
  if "$@" >/dev/null 2>&1; then
    echo "OK"
  else
    echo "LỖI"
  fi
}

echo "RustDesk Kiosk · VPS status · $(date '+%F %T %Z')"

section "Ứng dụng"
pm2 status kiosk-chat 2>/dev/null || echo "PM2 hoặc kiosk-chat chưa chạy"
printf 'API health: '
ok_or_fail curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/api/health"
curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null || true
echo

section "Dữ liệu"
if [ -f "${DATABASE_PATH}" ]; then
  echo "Database: ${DATABASE_PATH} ($(du -h "${DATABASE_PATH}" | awk '{print $1}'))"
  sqlite3 -header -column "${DATABASE_PATH}" "
    SELECT
      (SELECT COUNT(*) FROM devices) AS devices,
      (SELECT COUNT(*) FROM devices WHERE last_seen >= datetime('now', '-5 minutes')) AS online_5m,
      (SELECT COUNT(*) FROM chat_messages) AS messages,
      (SELECT COUNT(*) FROM chat_alerts WHERE acknowledged = 0) AS open_alerts,
      (SELECT COUNT(*) FROM audit_logs) AS audit_rows;
  " 2>/dev/null || echo "Không đọc được thống kê database"
else
  echo "Không tìm thấy database: ${DATABASE_PATH}"
fi

section "Tài nguyên"
free -h | sed -n '1,2p'
df -h / | sed -n '1,2p'

section "Backup"
if [ -f /etc/cron.d/rustdesk-kiosk-backup ]; then
  echo "Cron: BẬT"
  cat /etc/cron.d/rustdesk-kiosk-backup
else
  echo "Cron: TẮT"
fi
if command -v rclone >/dev/null 2>&1 && rclone listremotes 2>/dev/null | grep -Fxq 'gdrive:'; then
  echo "Google Drive: ĐÃ LIÊN KẾT"
else
  echo "Google Drive: CHƯA LIÊN KẾT"
fi
if [ -f /var/log/rustdesk-kiosk-backup.log ]; then
  echo "Log backup gần nhất:"
  tail -n 5 /var/log/rustdesk-kiosk-backup.log
fi

section "Lỗi ứng dụng gần nhất"
pm2 logs kiosk-chat --err --lines 12 --nostream 2>/dev/null || echo "Chưa có log PM2"

section "Kết luận"
echo "Dashboard: http://<IP_VPS>:${PORT}"
echo "Lịch sử đầy đủ: mở tab Nhật ký trong dashboard"
