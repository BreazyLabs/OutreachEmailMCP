# node:22-slim (Debian/glibc): better-sqlite3 ships prebuilt binaries for it,
# so no compiler toolchain is needed (alpine/musl would require node-gyp).
FROM node:22-slim

# curl: used by docker-entrypoint.sh to fetch the breazyenv CLI + env at boot
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Breazy's private CA, which issues the *.internal certificates. Without it the
# browser half of the Pocket ID login succeeds and the server-side token
# exchange fails with a bare "fetch failed" and no certificate wording at all.
# It must be a real environment variable, not a .env entry: Node's TLS layer
# reads it at process start, before any app code runs. Public CAs are
# untouched — this appends, it does not replace the bundle.
COPY certs/breazy-root.crt /etc/ssl/breazy-root.crt
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/breazy-root.crt

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json drizzle.config.ts ./
COPY drizzle ./drizzle
COPY src ./src

ENV NODE_ENV=production
ENV DATA_DIR=/data
VOLUME /data

EXPOSE 3000 2525 1143 465 993

# node-based healthcheck: slim has no wget/curl. Probed every 10s so a
# rolling update sees a fresh replica become healthy quickly; the app answers
# 503 while draining so the router stops sending it new connections.
HEALTHCHECK --interval=10s --timeout=5s --retries=3 --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

COPY docker-entrypoint.sh /docker-entrypoint.sh
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["npx", "tsx", "src/index.ts"]
