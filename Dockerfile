FROM oven/bun:1.3.9-debian AS source

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
RUN --mount=type=cache,target=/root/.bun/install/cache bun install || true \
    && find node_modules -name msgpackr-extract -exec rm -rf {} + 2>/dev/null \
    && find node_modules -name msgpackr-extract -xtype l -delete 2>/dev/null; true

# ── API binary ──────────────────────────────────────────────────────────────
FROM source AS build-api
RUN NODE_ENV=production bun build --compile apps/cli/src/main.ts --outfile /out/boilerhouse

FROM debian:bookworm-slim AS api
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build-api /out/boilerhouse /boilerhouse
COPY --from=source /app/packages/db/drizzle /drizzle
EXPOSE 3000 9464
ENV NODE_ENV=production MIGRATIONS_DIR=/drizzle RUNTIME_TYPE=docker LISTEN_HOST=0.0.0.0 PORT=3000
ENTRYPOINT ["/boilerhouse"]
CMD ["api", "start"]

# ── Dashboard binary ────────────────────────────────────────────────────────
FROM source AS build-dashboard
RUN NODE_ENV=production bun build --compile apps/dashboard/src/server.ts --outfile /out/dashboard

FROM debian:bookworm-slim AS dashboard
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build-dashboard /out/dashboard /dashboard
EXPOSE 3001
ENV NODE_ENV=production LISTEN_HOST=0.0.0.0 PORT=3001
ENTRYPOINT ["/dashboard"]

# ── Trigger gateway binary ──────────────────────────────────────────────────
FROM source AS build-trigger-gateway
RUN NODE_ENV=production bun build --compile apps/trigger-gateway/src/server.ts --outfile /out/trigger-gateway

FROM debian:bookworm-slim AS trigger-gateway
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build-trigger-gateway /out/trigger-gateway /trigger-gateway
EXPOSE 3002
ENV NODE_ENV=production LISTEN_HOST=0.0.0.0 PORT=3002
ENTRYPOINT ["/trigger-gateway"]
