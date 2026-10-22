FROM oven/bun:1.3.14

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src

USER bun
EXPOSE 3000
CMD ["bun", "run", "start"]
