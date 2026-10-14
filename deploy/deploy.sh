#!/usr/bin/env bash
# deploy.sh — bring AC/DC up to the latest main and restart it.
#
# Same shape as Level 0's deploy script, so every platformvv app ships
# the same way: merge to main, and the acdc-autodeploy timer runs
# this every two minutes. It is just as safe to run by hand.
#
#   1. It exits early when main has nothing new, so a quiet tick never
#      restarts the service. --force deploys anyway (first install, or
#      after pulling by hand).
#   2. It waits while a game is in progress. Rooms live in memory, so a
#      restart mid-game ends it. After DEPLOY_DEFER_LIMIT_MIN of waiting
#      it goes ahead anyway, so a room left open can't block deploys.
#      The check happens before anything on disk changes.
#   3. It always deploys main. The droplet clones were made from
#      GitHub's default branch, which for some repos is an old feature
#      branch; the first run moves the checkout onto main.
#
# Only fast-forwards: if the checkout has diverged from main it fails
# loudly instead of producing a merge.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

SERVICE="acdc.service"
PORT="${ACDC_PORT:-3300}"
DEFER_LIMIT_MIN="${DEPLOY_DEFER_LIMIT_MIN:-45}"
DEFER_STAMP="/tmp/acdc-deploy-deferred-since"

FORCE=""
if [ "${1:-}" = "--force" ]; then FORCE=1; fi

# Under systemd we're already root; run by hand we need sudo.
SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

echo "==> Fetching origin/main"
git fetch --quiet origin +refs/heads/main:refs/remotes/origin/main
current=$(git rev-parse HEAD)
target=$(git rev-parse origin/main)
branch=$(git rev-parse --abbrev-ref HEAD)

if [ "$current" = "$target" ] && [ "$branch" = "main" ] && [ -z "$FORCE" ]; then
  echo "==> Already up to date — nothing to deploy"
  rm -f "$DEFER_STAMP"
  exit 0
fi

if [ "$current" != "$target" ]; then
  echo "==> New commits:"
  git --no-pager log --oneline "$current".."$target" | sed 's/^/      /'
fi

# ── Hold off while people are playing ────────────────────────────────

busy=""
if command -v curl >/dev/null 2>&1; then
  busy="$(curl -sS --max-time 3 "http://127.0.0.1:${PORT}/api/status" 2>/dev/null \
          | grep -o '"busy":[a-z]*' | cut -d: -f2 || true)"
fi

if [ "$busy" = "true" ]; then
  now=$(date +%s)
  [ -f "$DEFER_STAMP" ] || echo "$now" > "$DEFER_STAMP"
  since="$(cat "$DEFER_STAMP")"
  waited_min=$(( (now - since) / 60 ))

  if [ "$waited_min" -lt "$DEFER_LIMIT_MIN" ]; then
    echo "==> A game is in progress — deferring (${waited_min}/${DEFER_LIMIT_MIN} min)"
    exit 0
  fi
  echo "==> Game still in progress after ${waited_min} min — deploying anyway"
fi
rm -f "$DEFER_STAMP"

# ── Update the checkout ──────────────────────────────────────────────

if [ "$branch" != "main" ]; then
  echo "==> Switching checkout from $branch to main"
  git checkout main   # creates a local main tracking origin/main if missing
fi
git merge --ff-only origin/main

# ── Deploy ───────────────────────────────────────────────────────────

if git diff --name-only "$current" "$target" | grep -qx 'package-lock.json'; then
  echo "==> package-lock.json changed, reinstalling deps"
  $SUDO npm ci --omit=dev
else
  echo "==> Deps unchanged, skipping npm ci"
fi

echo "==> Restarting $SERVICE"
$SUDO systemctl restart "$SERVICE"

sleep 2
if $SUDO systemctl is-active --quiet "$SERVICE"; then
  echo "==> Deployed $(git rev-parse --short HEAD) — service is up"
else
  echo "!!! $SERVICE is not running after restart" >&2
  $SUDO systemctl status "$SERVICE" --no-pager --lines 20 >&2 || true
  exit 1
fi
