#!/usr/bin/env bash
# All children inherit this script's process group (no `set -m`),
# so `kill 0` in cleanup nukes the whole tree (pnpm + node + next + tail).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$ROOT/agent"
FRONTEND_DIR="$ROOT/frontend"

if [[ ! -f "$AGENT_DIR/.env.local" ]]; then
  echo "Missing $AGENT_DIR/.env.local" >&2
  exit 1
fi
if [[ ! -f "$FRONTEND_DIR/.env.local" ]]; then
  echo "Missing $FRONTEND_DIR/.env.local" >&2
  exit 1
fi

LOG_DIR="$ROOT/.dev-logs"
mkdir -p "$LOG_DIR"
: >"$LOG_DIR/agent.log"
: >"$LOG_DIR/frontend.log"

cleanup() {
  trap '' INT TERM EXIT
  echo
  echo "[dev] stopping..."
  # SIGTERM whole process group (script + every descendant).
  kill 0 2>/dev/null || true
  # Give them ~1s to exit, then SIGKILL stragglers.
  for _ in 1 2 3 4 5; do
    sleep 0.2
    pgrep -g $$ >/dev/null 2>&1 || break
  done
  kill -KILL 0 2>/dev/null || true
}
trap cleanup INT TERM EXIT

echo "[dev] starting agent..."
(
  cd "$AGENT_DIR"
  exec pnpm dev
) >"$LOG_DIR/agent.log" 2>&1 &
AGENT_PID=$!

echo "[dev] starting frontend..."
(
  cd "$FRONTEND_DIR"
  exec pnpm dev
) >"$LOG_DIR/frontend.log" 2>&1 &
FRONTEND_PID=$!

echo "[dev] agent pid=$AGENT_PID  frontend pid=$FRONTEND_PID  pgid=$$"
echo "[dev] logs: $LOG_DIR/{agent,frontend}.log"
echo "[dev] tailing both (Ctrl-C to stop)"
echo

tail -n +1 -F "$LOG_DIR/agent.log" "$LOG_DIR/frontend.log" &

# Exit as soon as either dev process dies (bash 3.2-compatible poll).
while kill -0 "$AGENT_PID" 2>/dev/null && kill -0 "$FRONTEND_PID" 2>/dev/null; do
  sleep 0.5
done
