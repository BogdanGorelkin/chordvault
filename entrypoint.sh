#!/bin/sh
set -e

DATA_DIR="/app/data"
mkdir -p "$DATA_DIR"

# ── Detect the UID/GID that owns the data directory ──────────────────────
# When users bind-mount a host folder (e.g. ./data:/app/data), the mounted
# directory retains the host's ownership.  We must run Node as THAT user so
# SQLite can open / create its database file without SQLITE_CANTOPEN errors.
#
# `stat -c` is BusyBox/GNU syntax (works on Alpine).
DATA_UID=$(stat -c '%u' "$DATA_DIR")
DATA_GID=$(stat -c '%g' "$DATA_DIR")

echo "ChordVault: data dir owned by UID=$DATA_UID GID=$DATA_GID"

# A fresh Docker named volume is owned by root. In that case, hand only the
# writable data directory to the unprivileged user bundled with the Node image.
# Bind mounts owned by another UID/GID continue to run as their host owner.
if [ "$DATA_UID" = "0" ] && [ "$DATA_GID" = "0" ]; then
  RUNTIME_UID=$(id -u node)
  RUNTIME_GID=$(id -g node)
  chown -R "$RUNTIME_UID:$RUNTIME_GID" "$DATA_DIR"
else
  RUNTIME_UID=$DATA_UID
  RUNTIME_GID=$DATA_GID
fi

echo "ChordVault: running as UID=$RUNTIME_UID GID=$RUNTIME_GID"

# ── Seed demo data (if requested) ───────────────────────────────────────
if [ "$DEMO_MODE" = "true" ] && [ ! -f "$DATA_DIR/chordvault.db" ]; then
  echo "Demo mode: seeding database..."
  if [ "$(id -u)" = "$RUNTIME_UID" ]; then
    node scripts/seed-data.mjs
  else
    su-exec "$RUNTIME_UID:$RUNTIME_GID" node scripts/seed-data.mjs
  fi
  echo "Demo mode: seeding complete"
fi

# ── Drop privileges and exec Node ───────────────────────────────────────
# If we are already running as the correct UID, just exec directly.
# Otherwise use su-exec (Alpine's lightweight alternative to gosu) to
# switch to the owner of the data directory.
if [ "$(id -u)" = "$RUNTIME_UID" ]; then
  exec node server.js
else
  exec su-exec "$RUNTIME_UID:$RUNTIME_GID" node server.js
fi
