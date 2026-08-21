# Overflow: getting started

Overflow keeps your coding agent working after your Claude, ChatGPT, or Grok
subscription hits its limit. It routes overflow traffic to a pool of discounted,
honestly-labeled open-weight models. You pay only for what spills over, and you
can also earn by selling idle GPU time into the same pool.

Live gateway: **https://overflow-gateway.fly.dev**
Console: the same URL in a browser.

There are two ways to use Overflow. Most people start as a **buyer**. If you have
spare GPU hardware, you can also be a **seller**.

---

## Part 1: Buyer (keep your agent working)

### Step 1: Get an API key

Open **https://overflow-gateway.fly.dev** and, under "New here? Get a key", enter
your email and click "Create my key". Your key (starting `ovf_`) is shown once,
so copy it somewhere safe. One key per email.

You can also get one from the terminal:

```bash
curl -s -X POST https://overflow-gateway.fly.dev/signup -H "content-type: application/json" -d '{"email":"you@example.com"}'
```

### Step 2: Add credit

Overflow is prepaid, no subscription. Sign in to the console with your key and
click a top-up pack ($10, $25, or $50). Payment is by card via Stripe. Credits
are non-refundable and valid for 12 months.

Your balance and every charge are always visible in the console.

### Step 3: Point your agent at Overflow

**Claude Code** (the common case). Set two environment variables, then run Claude
as normal. When your own subscription limit is reached, your session keeps going
on the pool instead of stopping.

```bash
export ANTHROPIC_BASE_URL=https://overflow-gateway.fly.dev
```

```bash
export ANTHROPIC_API_KEY=ovf_your_key_here
```

```bash
claude
```

**Any OpenAI-SDK tool** (Codex, Cursor, scripts). Use the OpenAI-compatible
endpoint:

- Base URL: `https://overflow-gateway.fly.dev/v1`
- API key: your `ovf_...` key

Example raw request:

```bash
curl -s https://overflow-gateway.fly.dev/v1/chat/completions \
  -H "authorization: Bearer ovf_your_key_here" \
  -H "content-type: application/json" \
  -d '{"model":"qwen3-coder","messages":[{"role":"user","content":"hello"}]}'
```

### Step 4: Know what you are getting

Every response tells you which model actually answered, in the response headers:

- `x-overflow-served-model`: the pool model that served you
- `x-overflow-upstream`: where it came from (a wholesale provider, or `worker:N`
  for a seller's machine)
- `x-overflow-cost-nanousd`: what that request cost
- `x-overflow-balance-nanousd`: your balance afterward

Substitution is never silent. A `claude-*` request is served by the nearest open
model (for example Qwen3-Coder or GLM), and the response says so.

### Step 5: Check balance and usage any time

In the console you see balance, total tokens through the pool, an estimate of
what you saved versus Claude's API price, and a line-by-line usage history.

From the terminal:

```bash
curl -s https://overflow-gateway.fly.dev/v1/key -H "x-api-key: ovf_your_key_here"
```

When your own subscription resets, keep using it as normal. Overflow only meters
what actually spills over to the pool.

---

## Part 2: Seller (earn from idle GPU time)

You sell compute you own, running an open-weight model. You never share an
account, a login, or a key with anyone. Buyers reach your hardware only through
Overflow's metered, hard-capped channel.

### Step 1: Run a local model server

You need an OpenAI-compatible server on your machine. Any of these work:

- **vLLM**: `vllm serve Qwen/Qwen3-Coder-480B-A35B-Instruct` (serves `/v1`)
- **Ollama**: `ollama serve` (OpenAI endpoint at `http://localhost:11434/v1`)
- **LM Studio / llama.cpp / text-generation-webui**: enable the OpenAI server

Note the exact model id your server reports. You will advertise that same id, and
Overflow's canary check rejects a worker that serves a different model than it
claims.

### Step 2: Create a listing

Sign in to the console with your key, scroll to "Sell capacity", and click "List
a worker". You set:

- **pool model id**: the public name buyers request (for example `qwen3-coder`)
- **exact model id your server reports**: used for the canary identity check
- **your price** per million input and output tokens (what you earn)
- **hard token cap**: the most this listing will ever serve, total
- **available until** (optional): a cutoff time, for example while you are away

You get a one-time registration token (`ovfw_...`) and a ready-to-run worker
command.

### Step 3: Start your worker

The console gives you the exact command. It looks like this:

```bash
docker run --rm --network host \
  -e OVERFLOW_GATEWAY_URL=wss://overflow-gateway.fly.dev \
  -e OVERFLOW_REG_TOKEN=ovfw_your_token \
  -e LOCAL_OPENAI_BASE=http://localhost:8000/v1 \
  overflow-worker
```

Build the image once from the `worker/` folder in this repo:
`docker build -t overflow-worker worker/`. You can also run it without Docker if
you have Bun: see `worker/README.md`.

The worker connects out to the gateway (so it works behind a home router with no
port forwarding), registers, passes the canary, and starts serving. Your listing
turns green ("live") in the console.

### Step 4: Watch earnings, stay in control

In the console, each listing shows live status, how much of its token cap is
used, and earnings so far. Two safety guarantees:

- **Hard cap**: the gateway stops routing to your listing the instant its token
  cap is reached. There is nothing to come home to but a payout.
- **Instant revoke**: click "revoke" and your worker is dropped from the pool and
  shut down within seconds.

### Step 5: Get paid

Under "Payouts", click "Set up payouts" once to complete Stripe Connect
onboarding (this is where your bank details go, handled entirely by Stripe). Once
you are above the $5 minimum, click "Request payout" any time to transfer your
available earnings.

---

## How the money works

- Buyers pay a per-token price and prepay in credit packs.
- Sellers set their own per-token ask and earn it on every token they serve.
- Overflow keeps a commission on marketplace traffic (currently 20% of the
  seller's ask) and a margin on wholesale traffic.
- All balances are exact to the nanodollar and visible to both sides.

## The rules that keep this legitimate

- No account sharing, ever. Overflow never touches your Claude, OpenAI, or any
  provider credentials.
- No silent model substitution. Every response is stamped with the model that
  produced it, and sellers are canary-checked.
- No prompt harvesting. Requests are metered, not logged.
- Hard caps and instant revocation, enforced authoritatively at the gateway.
- Open-weight models only in the pool. Proprietary models join later, and only
  through official partner channels.
