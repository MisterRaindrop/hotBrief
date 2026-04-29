# Copyright 2026 hotBrief contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0

FROM ubuntu:24.04

# Optional build mirrors. Defaults are upstream so the image builds
# correctly anywhere; mainland-China builds can speed up significantly
# by setting these via docker compose / docker build --build-arg.
ARG APT_MIRROR=""
ARG NPM_REGISTRY="https://registry.npmjs.org"

WORKDIR /app

# Install Node.js 18 + npm from the Ubuntu 24.04 default repos and a
# C/C++ toolchain. better-sqlite3 has prebuilt binaries on GitHub
# Releases, but in restricted-network environments the prebuild fetch
# can time out, in which case npm transparently falls back to compiling
# from source. Keeping make + g++ + python3 makes the build robust.
RUN set -eux; \
    if [ -n "$APT_MIRROR" ]; then \
      sed -i "s|http://archive.ubuntu.com|$APT_MIRROR|g; s|http://security.ubuntu.com|$APT_MIRROR|g; s|http://ports.ubuntu.com|$APT_MIRROR|g" /etc/apt/sources.list.d/ubuntu.sources; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        nodejs npm ca-certificates \
        python3 make g++; \
    rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./

RUN npm config set registry "$NPM_REGISTRY" \
 && npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force

COPY src ./src

ENV NODE_ENV=production
ENV CONFIG_PATH=/app/config.yml
ENV DATA_DIR=/app/data

VOLUME ["/app/data"]

CMD ["node", "src/index.js"]
