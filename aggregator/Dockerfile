# Copyright 2026 hotBrief contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0

FROM node:18-slim

# better-sqlite3 needs a C toolchain to build native bindings.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV CONFIG_PATH=/app/config.yml
ENV DATA_DIR=/app/data

VOLUME ["/app/data"]

CMD ["node", "src/index.js"]
