#!/usr/bin/env bash
# Prints fresh values for the bot's secrets. WEBHOOK_SECRET and GM_WEBHOOK_SECRET must match.
set -euo pipefail
webhook=$(openssl rand -hex 32)
echo "SESSION_KEY=$(openssl rand -base64 32)"
echo "WEBHOOK_SECRET=$webhook"
echo "GM_WEBHOOK_SECRET=$webhook"
echo "GM_ADMIN_SECRET=$(openssl rand -hex 32)"
