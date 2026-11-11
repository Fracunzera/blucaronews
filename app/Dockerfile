# Una sola imagen para "app" (web) y "worker" (RSS + datos). Sin dependencias nativas:
# SQLite viene incluido en Node 24 (node:sqlite).
FROM node:24-alpine

ENV NODE_ENV=production \
    NODE_NO_WARNINGS=1 \
    DATA_DIR=/data \
    SEED_DIR=/app/config-seed \
    PORT=3000

WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY app/src ./src
COPY app/public ./public
COPY config ./config-seed

# El volumen nombrado hereda este dueño la primera vez que se crea.
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 3000
CMD ["node", "src/server.js"]
