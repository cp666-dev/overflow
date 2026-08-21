FROM oven/bun:1-slim
WORKDIR /app
COPY worker.ts ./
# No dependencies: the worker uses only Bun/web built-ins (WebSocket, fetch).
CMD ["bun", "run", "worker.ts"]
