# ============================================================
# Stage 1: Install dependencies
# ============================================================
FROM oven/bun:1-alpine AS deps

WORKDIR /app

# Copy workspace package files for dependency resolution
COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/
COPY apps/dashboard/package.json ./apps/dashboard/
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY packages/docker/package.json ./packages/docker/
COPY packages/cli/package.json ./packages/cli/

# Install build tools for native deps, then install dependencies
RUN apk add --no-cache --virtual .build-deps python3 make g++ && \
    bun install --frozen-lockfile && \
    apk del .build-deps

# ============================================================
# Stage 2: Build
# ============================================================
FROM oven/bun:1-alpine AS build

WORKDIR /app

# Copy installed dependencies
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/apps/dashboard/node_modules ./apps/dashboard/node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/packages/docker/node_modules ./packages/docker/node_modules
COPY --from=deps /app/packages/cli/node_modules ./packages/cli/node_modules

# Copy source code
COPY . .

# Build all packages
RUN bun run build

# ============================================================
# Stage 3: Production
# ============================================================
FROM oven/bun:1-alpine AS production

WORKDIR /app

# Install runtime dependencies:
# - rclone: installed from official script to get latest version (apk lags behind)
# - curl, unzip: for healthcheck and rclone install
RUN apk add --no-cache curl unzip && \
    curl -O https://downloads.rclone.org/rclone-current-linux-amd64.zip && \
    unzip rclone-current-linux-amd64.zip && \
    cp rclone-*-linux-amd64/rclone /usr/bin/ && \
    chmod +x /usr/bin/rclone && \
    rm -rf rclone-*

# Copy built application and dependencies
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=build /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=build /app/packages/docker/node_modules ./packages/docker/node_modules

# Copy built output
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/dashboard/dist ./apps/dashboard/dist
COPY --from=build /app/packages/db/drizzle ./apps/api/dist/drizzle

# Copy package.json files (needed for module resolution)
COPY --from=build /app/package.json ./
COPY --from=build /app/apps/api/package.json ./apps/api/
COPY --from=build /app/packages/core/package.json ./packages/core/
COPY --from=build /app/packages/db/package.json ./packages/db/
COPY --from=build /app/packages/docker/package.json ./packages/docker/

# Set environment
ENV NODE_ENV=production

# Expose API port
EXPOSE 3000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/api/v1/health || exit 1

# Create /data directory
RUN mkdir -p /data

# Start the API server
CMD ["bun", "run", "apps/api/dist/index.js"]
