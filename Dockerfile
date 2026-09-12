# syntax=docker/dockerfile:1

FROM node:22-alpine

# The app has no runtime dependencies, so there is no npm install step and no
# node_modules in the image - just the Node runtime and ~30 KB of source.
WORKDIR /app

ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    HEALTH_PORT=8080 \
    # Bound inside the container as an unprivileged user, so the well-known
    # Egate ports are mapped in from the host instead (see compose.yaml).
    LISTEN_PORTS=11020,19800

COPY package.json ./
COPY src/ ./src/

# `node` (uid 1000) ships with the base image.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

VOLUME ["/app/data"]
EXPOSE 11020 19800 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||8080)).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form, so PID 1 is node and it receives SIGTERM directly for a clean
# shutdown (pending readings are flushed to disk before exit).
CMD ["node", "src/index.js"]
