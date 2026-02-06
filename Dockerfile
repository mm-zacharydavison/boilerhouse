# ============================================================
# Stage 1: Install dependencies
# ============================================================
FROM oven/bun:1-alpine AS deps

WORKDIR /app

# Copy workspace package files for dependency resolution
COPY package.json bun.lockb ./
COPY apps/api/package.json ./apps/api/
COPY apps/dashboard/package.json ./apps/dashboard/
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY packages/docker/package.json ./packages/docker/
COPY packages/cli/package.json ./packages/cli/

# Install dependencies
RUN bun install --frozen-lockfile

# ============================================================
# Stage 2: Build
# ============================================================
FROM oven/bun:1-alpine AS build

WORKDIR /app

# Copy installed dependencies
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/packages/docker/node_modules ./packages/docker/node_modules

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
# - rclone: for state sync to S3/GCS/etc
# - curl: for healthcheck
RUN apk add --no-cache rclone curl

# Copy built application and dependencies
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=build /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=build /app/packages/docker/node_modules ./packages/docker/node_modules

# Copy built output
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/docker/dist ./packages/docker/dist

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

# Run as non-root user (bun user from oven/bun image)
USER bun

# Start the API server
CMD ["bun", "run", "apps/api/dist/index.js"]
