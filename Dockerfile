FROM node:20-bookworm-slim

# security refresh
RUN set -eux; apt-get update; apt-get upgrade -y --no-install-recommends; rm -rf /var/lib/apt/lists/*

WORKDIR /home/node/app

# deps first for cache
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# app
COPY extension/index.js ./index.js
COPY extension/lib ./lib
COPY extension/ui  ./ui

USER node
CMD ["node", "."]
