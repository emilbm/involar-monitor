# syntax=docker/dockerfile:1

# Node 24 for `node:sqlite`, which is available unflagged there. The app has no
# npm dependencies, so there is no install step and no node_modules in the
# image - just the Node runtime and the source.
FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    WEB_PORT=8080 \
    # Bound inside the container as an unprivileged user, so the well-known
    # Egate ports are mapped in from the host instead (see compose.yaml).
    LISTEN_PORTS=11020,19800

COPY package.json ./
COPY src/ ./src/
COPY web/ ./web/

# `node` (uid 1000) ships with the base image.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

VOLUME ["/app/data"]
EXPOSE 11020 19800 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEB_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form, so PID 1 is node and it receives SIGTERM directly for a clean
# shutdown (the database is checkpointed and closed before exit).
CMD ["node", "src/index.js"]
