FROM alpine:3.22

RUN apk add --no-cache nodejs-current npm tzdata git

WORKDIR /home/node/app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY extension/index.js ./index.js
COPY extension/lib ./lib
COPY extension/ui  ./ui

# ensure runtime perms
RUN addgroup --gid 1000 node || true \
 && adduser  --uid 1000 --ingroup node --shell /bin/sh --home /home/node --disabled-password node || true \
 && install -d -o node -g node /home/node/app/data \
 && chown -R node:node /home/node

USER node
CMD ["node","."]
