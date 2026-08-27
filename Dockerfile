FROM alpine:3.24.1

WORKDIR /app

COPY package.json package-lock.json ./
RUN apk add --no-cache nodejs npm \
    && apk add --no-cache --virtual .build-deps python3 make g++ nodejs-dev \
    && npm ci --omit=dev \
    && apk del npm .build-deps

COPY auth.js db.js downloads.js server.js ./
COPY public ./public

RUN mkdir -p /app/data

ENV HOST=0.0.0.0 \
    PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]