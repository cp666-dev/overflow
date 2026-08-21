# Overflow seller worker

Turn idle GPU time into earnings. This worker connects out to the Overflow
gateway, registers your capacity listing, and serves an open-weight model you
run locally. You never share an account, a login, or a key with anyone: buyers
reach your hardware only through the gateway's metered, hard-capped channel.

## What you need

1. A local **OpenAI-compatible** model server. Any of these expose one:
   - **vLLM**: `vllm serve Qwen/Qwen3-Coder-480B-A35B-Instruct` (serves `/v1`)
   - **Ollama**: `ollama serve` (OpenAI endpoint at `http://localhost:11434/v1`)
   - **LM Studio / llama.cpp / text-generation-webui**: enable the OpenAI server
2. A **listing** created in the Overflow console. It gives you a one-time
   registration token (`ovfw_...`) and is where you set your price, token cap,
   and availability window. The exact model id you advertise must match what
   your local server reports, or the gateway's canary check rejects the worker.

## Run it

```
docker build -t overflow-worker .
docker run --rm --network host \
  -e OVERFLOW_GATEWAY_URL=wss://overflow-gateway.fly.dev \
  -e OVERFLOW_REG_TOKEN=ovfw_your_token \
  -e LOCAL_OPENAI_BASE=http://localhost:8000/v1 \
  -e WORKER_TOKEN_CAP=50000000 \
  overflow-worker
```

Or without Docker, if you have Bun:

```
OVERFLOW_GATEWAY_URL=wss://overflow-gateway.fly.dev \
OVERFLOW_REG_TOKEN=ovfw_your_token \
LOCAL_OPENAI_BASE=http://localhost:8000/v1 \
bun run worker.ts
```

## Environment

| var | required | purpose |
|-----|----------|---------|
| `OVERFLOW_GATEWAY_URL` | yes | gateway base (`https://`/`wss://`, auto-normalized) |
| `OVERFLOW_REG_TOKEN` | yes | one-time listing token from the console |
| `LOCAL_OPENAI_BASE` | yes | your local server's `/v1` base |
| `LOCAL_OPENAI_KEY` | no | bearer for your local server, if it needs one |
| `WORKER_TOKEN_CAP` | no | self-enforced token ceiling (defense in depth; the gateway meter is authoritative) |

## Safety model

- **Hard cap**: the gateway stops routing to your listing the instant its token
  cap is reached, and the worker independently stops at `WORKER_TOKEN_CAP`.
- **Instant revoke**: hitting "Revoke" in the console closes this connection and
  drops your listing from the pool within seconds.
- **Reconnect**: transient disconnects auto-reconnect with backoff; your listing
  resumes serving when the socket is back.
