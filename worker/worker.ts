// Overflow seller worker.
//
// Connects OUT to the gateway over WebSocket (works behind home NAT), registers
// with a one-time token, then relays each inference request to a LOCAL
// OpenAI-compatible model server (vLLM, Ollama, llama.cpp, LM Studio, ...).
//
// The worker shares no credentials with anyone: buyers reach it only through the
// gateway's metered channel, and it self-enforces its own token cap as a second
// line of defense behind the gateway's authoritative meter.
//
// Env:
//   OVERFLOW_GATEWAY_URL   e.g. wss://overflow-gateway.fly.dev   (required)
//   OVERFLOW_REG_TOKEN     ovfw_...  one-time listing token       (required)
//   LOCAL_OPENAI_BASE      e.g. http://localhost:8000/v1          (required)
//   LOCAL_OPENAI_KEY       bearer for the local server            (optional)
//   WORKER_TOKEN_CAP       self-enforced total-token ceiling      (optional)

const GATEWAY = requireEnv("OVERFLOW_GATEWAY_URL").replace(/^http/, "ws").replace(/\/$/, "");
const REG_TOKEN = requireEnv("OVERFLOW_REG_TOKEN");
const LOCAL_BASE = requireEnv("LOCAL_OPENAI_BASE").replace(/\/$/, "");
const LOCAL_KEY = process.env.LOCAL_OPENAI_KEY;
const SELF_CAP = Number(process.env.WORKER_TOKEN_CAP ?? "0"); // 0 = rely on gateway

let tokensServed = 0;
let ws: WebSocket;
let reconnectDelay = 1000;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing required env ${name}`);
    process.exit(1);
  }
  return v;
}

function connect() {
  ws = new WebSocket(`${GATEWAY}/worker/connect`);

  ws.addEventListener("open", () => {
    reconnectDelay = 1000;
    log("connected, registering");
    send({ t: "register", regToken: REG_TOKEN });
  });

  ws.addEventListener("message", (ev) => {
    let msg: any;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    switch (msg.t) {
      case "registered":
        log(`registered as worker #${msg.workerId} serving ${msg.poolModel}`);
        break;
      case "rejected":
        console.error(`rejected: ${msg.reason}`);
        process.exit(1);
        break;
      case "ping":
        send({ t: "pong" });
        break;
      case "revoke":
        log("revoked by seller, shutting down");
        process.exit(0);
        break;
      case "infer":
      case "canary":
        void handleInfer(msg.id, msg.body);
        break;
    }
  });

  ws.addEventListener("close", () => {
    log(`disconnected, reconnecting in ${reconnectDelay}ms`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  });

  ws.addEventListener("error", () => {
    /* close handler drives reconnect */
  });
}

function send(o: any) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o));
}

async function handleInfer(id: string, body: any) {
  if (SELF_CAP > 0 && tokensServed >= SELF_CAP) {
    send({ t: "error", id, message: "worker self-cap reached" });
    return;
  }
  try {
    const res = await fetch(`${LOCAL_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(LOCAL_KEY ? { authorization: `Bearer ${LOCAL_KEY}` } : {}),
      },
      body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
    });
    if (!res.ok || !res.body) {
      send({ t: "error", id, message: `local server ${res.status}` });
      return;
    }

    let usage = { prompt_tokens: 0, completion_tokens: 0, model: body.model };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let data: any;
        try {
          data = JSON.parse(payload);
        } catch {
          continue;
        }
        if (data.usage) {
          usage = {
            prompt_tokens: data.usage.prompt_tokens ?? usage.prompt_tokens,
            completion_tokens: data.usage.completion_tokens ?? usage.completion_tokens,
            model: data.model ?? usage.model,
          };
        }
        // Relay content chunks (skip the usage-only final frame).
        if (data.choices?.length) {
          send({ t: "chunk", id, data: { model: data.model, choices: data.choices } });
        }
      }
    }
    tokensServed += usage.prompt_tokens + usage.completion_tokens;
    send({ t: "done", id, usage });
    log(`served ${id}: ${usage.prompt_tokens}+${usage.completion_tokens} tok (total ${tokensServed})`);
  } catch (e) {
    send({ t: "error", id, message: String(e) });
  }
}

function log(m: string) {
  console.log(`[overflow-worker] ${m}`);
}

connect();
