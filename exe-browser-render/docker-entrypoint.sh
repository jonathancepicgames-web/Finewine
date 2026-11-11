#!/usr/bin/env bash
set -Eeuo pipefail

SCREEN="${GAME_SCREEN:-1024x768x24}"
export DISPLAY=:0

mkdir -p /tmp/arcade-home /tmp/arcade-wineprefix /tmp/arcade-hub-data
chown -R arcade:arcade /tmp/arcade-home /tmp/arcade-wineprefix /tmp/arcade-hub-data

Xvfb :0 -screen 0 "$SCREEN" -ac +extension GLX +render -noreset >/tmp/arcade-xvfb.log 2>&1 &
XVFB_PID=$!
for attempt in $(seq 1 40); do
  [[ -S /tmp/.X11-unix/X0 ]] && break
  sleep 0.25
done
if [[ ! -S /tmp/.X11-unix/X0 ]]; then
  echo "Xvfb failed to create display :0" >&2
  cat /tmp/arcade-xvfb.log >&2 || true
  exit 1
fi

openbox --sm-disable >/tmp/arcade-openbox.log 2>&1 &
OPENBOX_PID=$!
x11vnc -display :0 -localhost -forever -shared -nopw -rfbport 5900 -noxdamage -quiet >/tmp/arcade-x11vnc.log 2>&1 &
VNC_PID=$!
for attempt in $(seq 1 40); do
  if (echo > /dev/tcp/127.0.0.1/5900) >/dev/null 2>&1; then break; fi
  sleep 0.25
done
websockify 127.0.0.1:6080 127.0.0.1:5900 >/tmp/arcade-websockify.log 2>&1 &
WEBSOCKIFY_PID=$!
for attempt in $(seq 1 40); do
  if (echo > /dev/tcp/127.0.0.1/6080) >/dev/null 2>&1; then break; fi
  sleep 0.25
done
if ! (echo > /dev/tcp/127.0.0.1/6080) >/dev/null 2>&1; then
  echo "websockify failed to start" >&2
  cat /tmp/arcade-websockify.log >&2 || true
  exit 1
fi

cleanup() {
  kill "$WEBSOCKIFY_PID" "$VNC_PID" "$OPENBOX_PID" "$XVFB_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Initialize a 64-bit Wine prefix with 32-bit WoW64 support. The same prefix
# can launch both 32-bit and 64-bit PE executables when wine32 + wine64 exist.
runuser -u arcade -- env DISPLAY=:0 HOME=/tmp/arcade-home WINEPREFIX=/tmp/arcade-wineprefix WINEARCH=win64 WINEDEBUG=-all wineboot -u \
  >/tmp/arcade-wineboot.log 2>&1 || echo "Wine prefix initialization returned a warning; first launch will retry."

exec node /app/server.mjs
