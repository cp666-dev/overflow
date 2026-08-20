# Overflow Gateway

The Phase 1 product: a metered, prepaid, OpenAI- and Anthropic-compatible gateway that routes requests for capped subscription models to discounted open-model equivalents, stamps every response with the model that actually served it, and debits a per-key credit balance from an append-only usage ledger.

## How it works

The gateway is **shape-preserving**: an OpenAI-shaped request (`/v1/chat/completions`) only routes to an upstream with an OpenAI-compatible endpoint, and an Anthropic-shaped request (`/v1/messages`) only routes to an upstream with an Anthropic-compatible endpoint (DeepSeek and Z.AI both expose one). No cross-shape translation exists, which keeps streaming, tool use, and new API features working without maintenance.

Flow per request: authenticate key → reject if balance ≤ 0 (402) → match requested model against the routing table → rewrite model, forward, stream back byte-for-byte → scan SSE for token usage → debit balance and append to ledger → stamp `x-overflow-served-model` and `x-overflow-upstream` headers.

## Run it

```
cd gateway
bun install
bun run cli keys create --name me
bun run cli credit add --id 1 --usd 5
bun start
```

Set at least one upstream provider key in `gateway/.env` (routes whose upstream has no key are skipped automatically):

- `DEEPSEEK_API_KEY` (OpenAI + Anthropic shapes, cheapest)
- `ZAI_API_KEY` (OpenAI + Anthropic shapes, GLM models)
- `DEEPINFRA_API_KEY` (OpenAI shape, Qwen3-Coder)

## Use it with Claude Code

```
export ANTHROPIC_BASE_URL=http://localhost:8484
export ANTHROPIC_API_KEY=ovf_yourkey
claude
```

Any OpenAI-SDK tool works too: base URL `http://localhost:8484/v1`, API key `ovf_...`.

## Endpoints

- `POST /v1/chat/completions`: OpenAI shape, metered
- `POST /v1/messages`: Anthropic shape, metered
- `POST /v1/messages/count_tokens`: passthrough, un-metered
- `GET /v1/models`: pool models with pricing
- `GET /v1/key`: your balance
- `GET /healthz`

## Money

All balances are integers in nanodollars (1e-9 USD); prices in the routing table are USD per million tokens, which conveniently equals microdollars per token. Credits are CLI-managed for now; Stripe top-ups are the next step. Data lives in SQLite (`gateway/data/overflow.db`, WAL mode); swap for Postgres when it outgrows one box.

## Tests

`bun test` runs an integration suite against a mock upstream speaking both shapes: auth rejection, 402 on empty balance, unroutable models, metering of streaming and non-streaming requests in both shapes, ledger consistency, and honest model stamping.
