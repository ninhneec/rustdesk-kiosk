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

record_backup_audit() {
  local action="$1"
  local success="$2"
  local detail="$3"
  sqlite3 "${DATABASE_PATH}" ".timeout 10000" \
    "INSERT INTO audit_logs (actor_type, actor_id, action, entity_type, entity_id, success, details)
     VALUES ('system', 'backup-cron', '${action}', 'backup', NULL, ${success}, '${detail}');" \
    >/dev/null 2>&1 || true
}

backup_failed() {
  local exit_code=$?
  set +e
  record_backup_audit "backup.failed" 0 '{"destination":"google-drive"}'
  exit "${exit_code}"
}
trap backup_failed ERR

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
record_backup_audit "backup.success" 1 '{"destination":"google-drive"}'
trap - ERR
echo "Backup uploaded: ${RCLONE_REMOTE}/$(basename "${ARCHIVE}")"
