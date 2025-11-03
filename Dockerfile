ARG build_arch=amd64

FROM multiarch/alpine:${build_arch}-v3.12

RUN addgroup -g 1000 node && \
    adduser -u 1000 -G node -s /bin/sh -D node && \
    apk add --no-cache nodejs tzdata

WORKDIR /home/node/app

COPY package.json extension/index.js /home/node/app/
COPY extension/lib /home/node/app/lib
COPY extension/ui /home/node/app/ui

RUN mkdir -p /home/node/app/data && \
    apk add --no-cache git npm && \
    npm install --production && \
    apk del git npm && \
    chown -R node:node /home/node/app

USER node

CMD ["node", "."]
