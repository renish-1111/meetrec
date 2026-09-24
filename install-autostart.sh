#!/usr/bin/env bash
# Installs the MeetRec bridge as a systemd user service that starts in the
# background every time you log in (and restarts if it crashes).
#
#   ./install-autostart.sh              install / update and start it now
#   ./install-autostart.sh --uninstall  stop it and remove it
#
# Re-run after moving this folder or changing Node versions (e.g. with nvm),
# since the service file records their absolute paths.
set -euo pipefail

SERVICE=meetrec-bridge.service
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_FILE="$UNIT_DIR/$SERVICE"
BRIDGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/bridge" && pwd)"
PORT=$(grep -E '^PORT=' "$BRIDGE_DIR/.env" 2>/dev/null | cut -d= -f2 || true)
PORT=${PORT:-17643}

if [[ "${1:-}" == "--uninstall" ]]; then
  systemctl --user disable --now "$SERVICE" 2>/dev/null || true
  rm -f "$UNIT_FILE"
  systemctl --user daemon-reload
  echo "Removed $SERVICE. The bridge will no longer start at login."
  exit 0
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "error: node not found on PATH. Install Node.js (or 'nvm use') and re-run." >&2
  exit 1
fi
NODE_BIN="$(readlink -f "$NODE_BIN")"

if [[ ! -d "$BRIDGE_DIR/node_modules" ]]; then
  echo "Installing bridge dependencies..."
  (cd "$BRIDGE_DIR" && "$(dirname "$NODE_BIN")/npm" install --omit=dev)
fi
if [[ ! -f "$BRIDGE_DIR/.env" ]]; then
  cp "$BRIDGE_DIR/.env.example" "$BRIDGE_DIR/.env"
  echo "Created bridge/.env from .env.example. Set OBS_WEBSOCKET_PASSWORD in it if OBS uses one."
fi

# A bridge started by hand (npm start) would hold the port and make the
# service fail to start.
if ! systemctl --user is-active --quiet "$SERVICE" && ss -ltn "sport = :$PORT" | grep -q LISTEN; then
  echo "error: port $PORT is already in use, probably by a bridge you started with 'npm start'." >&2
  echo "Stop it (Ctrl+C in that terminal) and re-run this script." >&2
  exit 1
fi

mkdir -p "$UNIT_DIR"
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=MeetRec bridge (auto-records Google Meet calls in OBS)
# Starts with your desktop login, so an OBS launched by the bridge can open
# on your screen (DISPLAY etc. come from the graphical session).
After=graphical-session.target
PartOf=graphical-session.target

[Service]
WorkingDirectory=$BRIDGE_DIR
ExecStart=$NODE_BIN server.js
Environment=PATH=$(dirname "$NODE_BIN"):/snap/bin:/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=3
# Only stop the bridge itself on restart; never kill an OBS it launched
# (that would cut off a recording in progress).
KillMode=process

[Install]
WantedBy=graphical-session.target
EOF

systemctl --user daemon-reload
systemctl --user enable "$SERVICE" >/dev/null
systemctl --user restart "$SERVICE"
sleep 1

if systemctl --user is-active --quiet "$SERVICE"; then
  echo "Installed and running. The bridge now starts automatically when you log in."
  echo
  echo "  Status:  systemctl --user status $SERVICE"
  echo "  Logs:    journalctl --user -u $SERVICE -f"
  echo "  Restart: systemctl --user restart $SERVICE   (after editing bridge/.env)"
  echo "  Remove:  $0 --uninstall"
else
  echo "error: service failed to start. Recent logs:" >&2
  journalctl --user -u "$SERVICE" -n 20 --no-pager >&2
  exit 1
fi
