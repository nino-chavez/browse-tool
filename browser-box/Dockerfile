# A real headed Google Chrome on a virtual display, driven over CDP from the host.
#
# Headed matters: Facebook's menus, typeaheads and file choosers silently no-op
# under --headless=new, and that is the failure this image exists to avoid. Xvfb
# gives Chrome a genuine X server to composite into, so it behaves like a
# desktop browser while never touching the operator's screen.
#
# Chrome, not Debian's chromium. This image ran chromium originally on the belief
# that Google published no arm64 Linux build; that is false — Google's own apt
# index lists google-chrome-stable for arm64, so this runs native on Apple
# silicon with no emulation. The switch matters because Debian's chromium is
# built without Google's API keys, which disables Chrome Sync outright: no
# signing in with a Google account, no synced passwords, no synced extensions.
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc novnc websockify x11-utils xdotool \
      socat curl gnupg procps ca-certificates \
      fonts-liberation fonts-dejavu-core fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# Google's apt repo, added before the USER switch because both the keyring and
# the install need root. arch is read from dpkg rather than hardcoded so this
# builds the same on arm64 and amd64.
RUN curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
      | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/google-chrome.gpg]" \
       "https://dl.google.com/linux/chrome/deb/ stable main" \
       > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# Xvfb creates its socket here and cannot mkdir it as a non-root user — without
# this the X socket never appears and every readiness check on it spins out.
RUN mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

RUN useradd -m -u 1000 -s /bin/bash box && mkdir -p /profile && chown box:box /profile
USER box
WORKDIR /home/box

COPY --chown=box:box entrypoint.sh /home/box/entrypoint.sh
RUN chmod +x /home/box/entrypoint.sh

ENV CDP_PORT=9400 \
    VNC_PORT=6080 \
    SCREEN=1440x900x24 \
    PROFILE_DIR=/profile

EXPOSE 9400 6080
CMD ["/home/box/entrypoint.sh"]
