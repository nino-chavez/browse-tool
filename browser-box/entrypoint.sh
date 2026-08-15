#!/bin/bash
# Bring up the display, the viewer, the CDP bridge, then Chrome.
set -euo pipefail

DISPLAY_NUM=99
export DISPLAY=":${DISPLAY_NUM}"

# Both of these are stale-lock clears, and both are required because the box
# restarts in place (--restart unless-stopped) and remounts a profile that
# outlives any one container.
#
# Xvfb refuses to start when a lock for its display number exists ("Server is
# already active for display 99"). A restarted container keeps its writable
# layer, so the lock from the previous run survives and every retry fails
# identically — a permanent crash loop from one transient failure.
rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}"

# Chrome's singleton lock records the hostname that holds the profile, and a
# container's hostname is its container ID — so after any recreate the lock
# names a host that cannot exist, and Chrome treats the profile as in use by
# someone else. Clearing it is safe here because the bind mount gives exactly
# one container ownership of this profile at a time.
rm -f "${PROFILE_DIR}/SingletonLock" \
      "${PROFILE_DIR}/SingletonCookie" \
      "${PROFILE_DIR}/SingletonSocket"

Xvfb "$DISPLAY" -screen 0 "$SCREEN" -nolisten tcp &
# Ask the X server whether it is actually serving, rather than watching for its
# socket file. The socket is the wrong signal: Xvfb also accepts connections on
# an abstract socket, so a missing file proves nothing and a present one does
# not mean the server is ready to answer.
for i in $(seq 1 100); do
  xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && break
  sleep 0.1
  [ "$i" = 100 ] && { echo "Xvfb never became ready on $DISPLAY" >&2; exit 1; }
done

# Viewer: x11vnc exposes the virtual screen, websockify wraps it for noVNC so it
# opens in an ordinary browser tab. This is how a one-time interactive login
# happens (site cookies live in the container, never on the host).
x11vnc -display "$DISPLAY" -forever -shared -nopw -quiet -rfbport 5900 &
websockify --web=/usr/share/novnc "0.0.0.0:${VNC_PORT}" localhost:5900 >/dev/null 2>&1 &

# Chrome binds DevTools to 127.0.0.1 and ignores --remote-debugging-address,
# so the mapped port would answer nothing from the host. socat listens on the
# container IP at the SAME port number, which keeps the webSocketDebuggerUrl
# Chrome advertises (ws://127.0.0.1:<port>) valid on the host once Docker maps
# that port. A different port on either side breaks puppeteer's connect(), which
# dials the advertised URL verbatim.
CONTAINER_IP="$(hostname -i | tr -d ' ')"
socat "TCP-LISTEN:${CDP_PORT},bind=${CONTAINER_IP},fork,reuseaddr" \
      "TCP:127.0.0.1:${CDP_PORT}" &

# --password-store=basic keeps cookie encryption deterministic. Without it
# Chrome's choice depends on whether a keyring happens to be present, and a
# profile written under one scheme is unreadable under the other — the session
# silently vanishes on restart. It is also what makes a profile portable between
# builds: with the basic store the key is derived, not stored, so a Cookies file
# written by one Chrome/Chromium build decrypts under another.
# --no-sandbox: Chrome's own sandbox relies on unprivileged user namespaces,
# which Docker's default seccomp profile blocks. The alternatives are worse:
# --cap-add=SYS_ADMIN hands the container broad host privileges, and
# seccomp=unconfined removes the syscall filter entirely. Keeping Docker's
# restrictions and letting the CONTAINER be the sandbox is the stronger
# boundary, and it is what Playwright's own images do. Paired with a non-root
# user and CDP bound to 127.0.0.1, nothing here is reachable off-host.
# No --remote-allow-origins here, deliberately. Chrome rejects a DevTools
# websocket handshake that carries an Origin header unless that flag permits it,
# and '*' permits every origin — verified: a handshake claiming
# "Origin: https://evil.example" was answered 101. That check exists to stop a
# web page you visit in your normal browser from reaching into this one. Nothing
# here needs the flag: puppeteer connects from Node and sends no Origin at all,
# which Chrome allows either way.
#
# It is only one layer. CDP is unauthenticated, so any process running as you can
# read the target UUID from 127.0.0.1:<port>/json/version and drive a fully
# logged-in browser. Loopback-only publishing keeps that local; this keeps a
# visited web page out of the local case.
exec google-chrome-stable \
  --no-sandbox \
  --remote-debugging-port="${CDP_PORT}" \
  --user-data-dir="${PROFILE_DIR}" \
  --password-store=basic \
  --disable-gpu \
  --no-first-run \
  --no-default-browser-check \
  --disable-features=Translate,AcceptCHFrame \
  --window-position=0,0 \
  --window-size="$(echo "${SCREEN%x*}" | tr 'x' ',')" \
  --start-maximized \
  about:blank
