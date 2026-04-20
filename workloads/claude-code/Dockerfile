FROM node:22-bookworm-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends git ca-certificates && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Install the ws package for WebSocket support + undici for the ProxyAgent
# used by the proxy-preload shim (see proxy-preload.mjs).
RUN npm init -y && npm install ws undici

# Copy the bridge server (plain Node.js ESM — no build step)
COPY bridge.mjs .
# Route all fetch/undici traffic through HTTP(S)_PROXY. Applies to every
# Node process that inherits these env vars — including the claude CLI.
COPY proxy-preload.mjs .

# Create non-root user — claude refuses --dangerously-skip-permissions as root
RUN useradd -m -s /bin/bash claude
RUN mkdir -p /workspace && chown claude:claude /workspace

ENV NODE_ENV=production
ENV BRIDGE_PORT=7880
ENV WORKSPACE_DIR=/workspace
ENV NODE_OPTIONS=--import=/app/proxy-preload.mjs

USER claude

EXPOSE 7880
