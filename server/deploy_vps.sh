#!/usr/bin/env bash
set -euo pipefail

# Compatibility entrypoint. This project intentionally deploys only the
# independent chat/dashboard backend; RustDesk remote traffic stays on the
# public RustDesk infrastructure unless a client is explicitly built for a
# self-hosted server.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/deploy_chat_only.sh" "$@"
