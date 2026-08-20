FROM oven/bun:1-slim
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY public ./public
ENV OVERFLOW_PORT=8484
ENV OVERFLOW_DB=/data/overflow.db
EXPOSE 8484
CMD ["bun", "run", "src/index.ts"]
