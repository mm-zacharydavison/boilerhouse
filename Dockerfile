FROM oven/bun:1.3.9-debian AS build

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
RUN bun install
RUN NODE_ENV=production bun build --compile apps/cli/src/main.ts --outfile boilerhouse

# Install @boilerhouse/core from npm so workload files can import it
WORKDIR /workloads
RUN bun init -y && bun add @boilerhouse/core

FROM gcr.io/distroless/base-nossl-debian12

COPY --from=build /app/boilerhouse /boilerhouse
COPY --from=build /app/packages/db/drizzle /drizzle
COPY --from=build /workloads/node_modules /workloads/node_modules

EXPOSE 3000 9464

ENV NODE_ENV=production
ENV MIGRATIONS_DIR=/drizzle
ENV RUNTIME_TYPE=docker
ENV LISTEN_HOST=0.0.0.0
ENV PORT=3000

ENTRYPOINT ["/boilerhouse"]
CMD ["api", "start"]
