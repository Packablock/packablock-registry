# Stage 1: Dependency builder and typechecker
FROM oven/bun:1 AS builder
WORKDIR /app

# Copy dependency definition files
COPY package.json bun.lock ./

# Install all dependencies (including devDependencies for typecheck)
RUN bun install --frozen-lockfile

# Copy source and config files
COPY tsconfig.json biome.json ./
COPY src/ ./src/
COPY index.ts ./

# Run static analysis and type checks to guarantee builds are always valid
RUN bun run typecheck

# Stage 2: Clean and minimal production runner
FROM oven/bun:1 AS runner
WORKDIR /app

# Copy package manifest
COPY package.json ./

# Copy runtime node_modules from the builder stage
COPY --from=builder /app/node_modules ./node_modules

# Copy source files
COPY --from=builder /app/src ./src
COPY --from=builder /app/index.ts ./

# Create persistent storage directory and secure it for the bun user
RUN mkdir -p /data && chown -R bun:bun /data

# Switch to the non-privileged default Bun user
USER bun

# Set core runtime environment variables
ENV NODE_ENV=production
ENV PORT=3030
ENV DATABASE_FILE=/data/packablock.sqlite

# Expose service port
EXPOSE 3030

# Start registry service
CMD ["bun", "run", "index.ts"]
