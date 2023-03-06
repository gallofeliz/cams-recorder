FROM node:18-alpine AS build

WORKDIR /build

ADD package.json package-lock.json ./

RUN npm i

ADD index.ts tsconfig.json ./

RUN npx ttsc

RUN npm prune --production && rm index.ts tsconfig.json package-lock.json

ADD index.html ./

# ------------

FROM node:18-alpine

RUN apk add --no-cache tzdata ffmpeg

WORKDIR /app

COPY --from=build /build ./

USER nobody

CMD ["node", "."]
