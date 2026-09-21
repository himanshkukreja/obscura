#!/usr/bin/env bash
# Generate production secrets. Run once, store the output somewhere safe, never commit it.
#
# READ THIS BEFORE RUNNING:
#
#   OBSCURA_MASTER_KEY wraps every content key. Lose it and every asset you have ever
#   encrypted becomes permanently unreadable - which is exactly the property that makes
#   deletion final, working equally well against you. Back it up somewhere you will still
#   have access to in two years, separately from your database backups.
#
#   Keeping a database backup that contains `content_keys` for LONGER than your deletion
#   SLA silently undoes cryptographic erasure: restoring it resurrects keys you promised
#   were destroyed. See docs/privacy.md section 5.
set -euo pipefail

gen() { openssl rand -base64 32; }

cat <<EOF
# ── Obscura production secrets — generated $(date -u +%Y-%m-%dT%H:%M:%SZ) ──
# Store in a secrets manager. Do not commit. Do not log.

OBSCURA_MASTER_KEY=$(gen)
OBSCURA_TOKEN_SEED=$(gen)
OBSCURA_INTEGRITY_SEED=$(gen)
OBSCURA_HASH_SALT=$(openssl rand -base64 24)
OBSCURA_INTEGRITY_KEY_ID=obscura-integrity-$(date -u +%Y-%m)

POSTGRES_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)
EOF
