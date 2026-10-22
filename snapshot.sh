#!/usr/bin/env bash
# Re-export the live app's source into this repository. Reads the live tree; writes only here.
set -euo pipefail
SRC=/data/apps/jarvis-live
DST="$(cd "$(dirname "$0")" && pwd)"
COMMIT=$(git -C "$SRC" rev-parse --short HEAD)
TMP=$(mktemp -d)
git -C "$SRC" archive HEAD -- . \
  ':(exclude)ctx' ':(exclude)ctx/**' ':(exclude)logs' ':(exclude)logs/**' \
  ':(exclude)audit.jsonl' ':(exclude).p4trace' ':(exclude).p4trace/**' \
  ':(exclude)executions.jsonl' ':(exclude)sessions.json' ':(exclude)sessions.json.*' \
  ':(exclude)tombstones.json' ':(exclude)purge.json' ':(exclude)chat_settings.json' \
  ':(exclude)modes.json' ':(exclude)pending.json' ':(exclude)artifacts.json' \
  ':(exclude)backups' ':(exclude)backups/**' ':(exclude)uploads' ':(exclude)uploads/**' \
  ':(exclude)_snap/**' ':(exclude)promotions' ':(exclude)promotions/**' \
  ':(exclude)scratch' ':(exclude)scratch/**' ':(exclude)tmp-proof' ':(exclude)tmp-proof/**' \
  ':(exclude)outbox' ':(exclude)outbox/**' ':(exclude)design-refs' ':(exclude)design-refs/**' \
  ':(exclude)widgets' ':(exclude)widgets/**' ':(exclude)web_guard.log' \
  | tar -x -C "$TMP"
rsync -a --delete --exclude '.git' --exclude 'snapshot.sh' --exclude 'SNAPSHOT.md' --exclude '.gitignore' \
  "$TMP"/ "$DST"/
rm -rf "$TMP"
sed -i "s/^- Commit captured: .*/- Commit captured: \`$COMMIT\` ($(date '+%-d %B %Y'))/" "$DST/SNAPSHOT.md" || true
cd "$DST" && git add -A && git commit -m "Source snapshot of the live app at $COMMIT" || echo "no changes"
