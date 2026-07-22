# node:22-slim (Debian/glibc): better-sqlite3 ships prebuilt binaries for it,
# so no compiler toolchain is needed (alpine/musl would require node-gyp).
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json drizzle.config.ts ./
COPY drizzle ./drizzle
COPY src ./src

ENV NODE_ENV=production
ENV DATA_DIR=/data
VOLUME /data

EXPOSE 3000 2525 1143

# node-based healthcheck: slim has no wget/curl
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "src/index.ts"]
