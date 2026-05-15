#!/usr/bin/env bash
# Backup the adventure project to a timestamped zip in the project's parent dir.
# Excludes heavy artefacts that are reproducible from package.json / pip / git:
#   - node_modules        (bun install)
#   - tts_sidecar/.venv   (chatterbox + torch, ~6 GB)
#   - tts_sidecar/voices  (regeneratable from generate_voices.py)
#   - .claude/worktrees   (sibling checkouts, often huge)
#   - .playwright-mcp     (session logs)
#   - media/*             (re-rendered on demand; also wiped pre-backup)
#   - .superpowers        (skill cache)
# .git is INCLUDED so the backup is a real restore point.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_NAME="$(basename "$PROJECT_DIR")"
PARENT_DIR="$(dirname "$PROJECT_DIR")"
TIMESTAMP="$(date +%Y%m%d-%H%M)"
OUT="$PARENT_DIR/${PROJECT_NAME}-backup-${TIMESTAMP}.zip"

MEDIA_DIR="$PROJECT_DIR/media"

# --- Safety: verify the media dir is real and is what we think it is -------
if [[ ! -d "$MEDIA_DIR" ]]; then
    echo "Error: $MEDIA_DIR does not exist." >&2
    exit 1
fi

cd "$MEDIA_DIR"
TEST_DIR="$(pwd -P)"  # -P resolves symlinks — paranoid mode engaged

# Belt: last path component must be "media"
if [[ "${TEST_DIR##*/}" != "media" ]]; then
    echo "Error: expected to be in 'media', got: $TEST_DIR" >&2
    exit 1
fi

# Suspenders: resolved path must match the project's media dir
EXPECTED="$(cd "$PROJECT_DIR/media" && pwd -P)"
if [[ "$TEST_DIR" != "$EXPECTED" ]]; then
    echo "Error: in '$TEST_DIR' but expected '$EXPECTED'" >&2
    exit 1
fi

# --- Preview what's about to get nuked ------------------------------------
echo "About to delete all files in: $TEST_DIR"
echo "(preserving any file named 'title.png')"
echo

DOOMED_COUNT="$(find . ! -name 'title.png' -type f | wc -l | tr -d ' ')"
echo "Files to be deleted: $DOOMED_COUNT"

if [[ "$DOOMED_COUNT" -gt 0 ]]; then
    echo "Sample (first 20):"
    find . ! -name 'title.png' -type f | head -20 | sed 's/^/  /'
fi
echo

read -n 1 -s -r -p "Press any key to proceed, Ctrl-C to abort..."
echo
echo

find . ! -name 'title.png' -type f -exec rm -f {} +

# --- Zip it up ------------------------------------------------------------
cd "$PARENT_DIR"

echo "Backing up $PROJECT_DIR"
echo "       -> $OUT"
echo

zip -r "$OUT" "$PROJECT_NAME" \
  -x "$PROJECT_NAME/node_modules/*" \
  -x "$PROJECT_NAME/tts_sidecar/.venv/*" \
  -x "$PROJECT_NAME/tts_sidecar/**/__pycache__/*" \
  -x "$PROJECT_NAME/tts_sidecar/**/.pytest_cache/*" \
  -x "$PROJECT_NAME/tts_sidecar/voices/*" \
  -x "$PROJECT_NAME/.claude/worktrees/*" \
  -x "$PROJECT_NAME/.playwright-mcp/*" \
  -x "$PROJECT_NAME/media/*" \
  -x "$PROJECT_NAME/.superpowers/*" \
  -x "$PROJECT_NAME/*.tsbuildinfo" \
  -x "$PROJECT_NAME/dist/*" \
  -x "$PROJECT_NAME/out/*"

echo
echo "Done. $(du -h "$OUT" | cut -f1) at $OUT"