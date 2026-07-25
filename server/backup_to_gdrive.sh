#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="${DATA_DIR:-/var/lib/rustdesk-kiosk-chat}"
DATABASE_PATH="${DATABASE_PATH:-${DATA_DIR}/devices.db}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/rustdesk-kiosk-chat}"
RCLONE_REMOTE="${RCLONE_REMOTE:-gdrive:rustdesk-kiosk-backups}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SNAPSHOT="${BACKUP_DIR}/devices-${STAMP}.db"
ARCHIVE="${SNAPSHOT}.gz"

install -d -m 750 "${BACKUP_DIR}"
if [ ! -f "${DATABASE_PATH}" ]; then
  echo "Database not found: ${DATABASE_PATH}" >&2
  exit 1
fi

sqlite3 "${DATABASE_PATH}" ".timeout 10000" ".backup '${SNAPSHOT}'"
gzip -9 "${SNAPSHOT}"
gzip -t "${ARCHIVE}"

REMOTE_NAME="${RCLONE_REMOTE%%:*}"
if ! rclone listremotes | grep -Fxq "${REMOTE_NAME}:"; then
  echo "Google Drive remote '${REMOTE_NAME}' is not configured. Run: sudo rclone config" >&2
  exit 2
fi

rclone copyto "${ARCHIVE}" "${RCLONE_REMOTE}/$(basename "${ARCHIVE}")" \
  --checkers 2 --transfers 1 --retries 3
find "${BACKUP_DIR}" -type f -name 'devices-*.db.gz' -mtime "+${RETENTION_DAYS}" -delete
echo "Backup uploaded: ${RCLONE_REMOTE}/$(basename "${ARCHIVE}")"
