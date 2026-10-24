FROM oven/bun:1.3.14 AS base
WORKDIR /app

FROM base AS dependencies-production
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

FROM base AS dependencies-development
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM base AS production
COPY --from=dependencies-production /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
USER bun
EXPOSE 3000
CMD ["bun", "run", "start"]

FROM base AS development
COPY --from=dependencies-development /app/node_modules ./node_modules
COPY package.json tsconfig.json biome.json .gitignore ./
COPY src ./src
COPY tests ./tests
RUN chown -R bun:bun /app
USER bun
CMD ["bun", "run", "test:domain"]
