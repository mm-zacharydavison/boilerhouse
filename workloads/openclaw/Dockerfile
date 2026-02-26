FROM node:22-bookworm-slim

WORKDIR /app

# Install openclaw and its dependencies, then promote openclaw's own files
# to /app so that `node openclaw.mjs` resolves ./dist/entry.js correctly
# while still finding its npm dependencies in /app/node_modules/.
RUN npm install openclaw && \
    cp node_modules/openclaw/openclaw.mjs . && \
    cp -r node_modules/openclaw/dist .
