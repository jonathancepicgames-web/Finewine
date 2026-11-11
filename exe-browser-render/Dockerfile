FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:0 \
    WINEPREFIX=/tmp/arcade-wineprefix \
    HOME=/tmp/arcade-home \
    WINEDEBUG=-all \
    LIBGL_ALWAYS_SOFTWARE=1 \
    NODE_ENV=production

# Wine 32-bit support is needed for many older Windows games. The desktop is
# virtual (Xvfb); no physical display or GPU is assumed.
RUN dpkg --add-architecture i386 \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      python3 \
      util-linux \
      unzip \
      xvfb \
      x11vnc \
      openbox \
      novnc \
      websockify \
      dosbox \
      scummvm \
      wine \
      wine32:i386 \
      wine64 \
      fonts-liberation \
      fonts-wine \
      libgl1-mesa-dri \
      libgl1-mesa-dri:i386 \
      libglx-mesa0 \
      libglx-mesa0:i386 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin arcade \
 && mkdir -p /tmp/arcade-hub-data /tmp/arcade-home /tmp/arcade-wineprefix \
 && chown -R arcade:arcade /tmp/arcade-home /tmp/arcade-wineprefix

EXPOSE 10000
ENTRYPOINT ["/app/docker-entrypoint.sh"]
