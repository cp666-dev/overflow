import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startGateway } from "../src/index";
import { createApiKey, addCredit, openDb } from "../src/db";
import type { GatewayConfig } from "../src/config";

// ---------- mock upstream: speaks both shapes, streaming and not ----------

const mockUpstream = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body: any = await req.json();

    if (url.pathname === "/oai/v1/chat/completions") {
      expect(req.headers.get("authorization")).toBe("Bearer mock-upstream-key");
      if (body.stream) {
        expect(body.stream_options?.include_usage).toBe(true);
        const chunks = [
          `data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: "hi" } }] })}\n\n`,
          `data: ${JSON.stringify({ model: body.model, choices: [], usage: { prompt_tokens: 100, completion_tokens: 40 } })}\n\n`,
          "data: [DONE]\n\n",
        ];
        return new Response(sse(chunks), { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({
        model: body.model,
        choices: [{ message: { role: "assistant", content: "hello" } }],
        usage: { prompt_tokens: 200, completion_tokens: 80 },
      });
    }

    if (url.pathname === "/ant/v1/messages") {
      expect(req.headers.get("x-api-key")).toBe("mock-upstream-key");
      if (body.stream) {
        const chunks = [
          `data: ${JSON.stringify({ type: "message_start", message: { model: body.model, usage: { input_tokens: 500, output_tokens: 1 } } })}\n\n`,
          `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "hey" } })}\n\n`,
          `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 60 } })}\n\n`,
          `data: ${JSON.stringify({ type: "message_stop" })}\n\n`,
        ];
        return new Response(sse(chunks), { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({
        model: body.model,
        content: [{ type: "text", text: "hey" }],
        usage: { input_tokens: 300, output_tokens: 120 },
      });
    }

    return new Response("nope", { status: 404 });
  },
});

function sse(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    async start(c) {
      for (const chunk of chunks) {
        c.enqueue(enc.encode(chunk));
        await Bun.sleep(5);
      }
      c.close();
    },
  });
}

// ---------- gateway under test ----------

const base = `http://localhost:${mockUpstream.port}`;
const testConfig: GatewayConfig = {
  upstreams: [
    { name: "mock", openaiBase: `${base}/oai/v1`, anthropicBase: `${base}/ant/v1`, apiKeyEnv: "MOCK_UPSTREAM_KEY" },
  ],
  routes: [
    {
      pool: "pool-model",
      upstream: "mock",
      upstreamModel: "upstream-model",
      inPerM: 1.0, // $1/M in
      outPerM: 2.0, // $2/M out
      match: [/^claude/, /^gpt/],
    },
  ],
};

process.env.MOCK_UPSTREAM_KEY = "mock-upstream-key";

const DB = "/tmp/overflow-test-" + Date.now() + ".db";
let gw: ReturnType<typeof startGateway>;
let gwUrl: string;
let apiKey: string;
let keyId: number;
let brokeKey: string;

beforeAll(() => {
  gw = startGateway({ port: 0, dbPath: DB, config: testConfig });
  gwUrl = `http://localhost:${gw.server.port}`;
  const db = openDb(DB);
  const created = createApiKey(db, "tester");
  apiKey = created.key;
  keyId = created.id;
  addCredit(db, keyId, 5_000_000_000); // $5
  brokeKey = createApiKey(db, "broke").key; // $0 balance
});

afterAll(() => {
  gw.server.stop(true);
  mockUpstream.stop(true);
});

function balance(): number {
  return (
    gw.db.query("SELECT balance_nano FROM api_keys WHERE id = ?").get(keyId) as any
  ).balance_nano;
}

describe("auth and balance gates", () => {
  test("rejects missing/invalid key with 401", async () => {
    const res = await fetch(`${gwUrl}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-x", messages: [] }),
    });
    expect(res.status).toBe(401);
  });

  test("rejects empty-balance key with 402 before touching upstream", async () => {
    const res = await fetch(`${gwUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": brokeKey, "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4", messages: [] }),
    });
    expect(res.status).toBe(402);
    const body: any = await res.json();
    expect(body.error.type).toBe("insufficient_credits");
  });

  test("unroutable model returns 404", async () => {
    const res = await fetch(`${gwUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "totally-unknown", messages: [] }),
    });
    expect(res.status).toBe(404);
  });
});

describe("metering", () => {
  test("non-streaming openai request is served, stamped, and debited", async () => {
    const before = balance();
    const res = await fetch(`${gwUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-overflow-served-model")).toBe("pool-model");
    const body: any = await res.json();
    expect(body.model).toBe("upstream-model"); // honest labeling: upstream model visible
    // 200 in @ $1/M + 80 out @ $2/M = 200_000 + 160_000 nano = 360_000
    expect(before - balance()).toBe(360_000);
    expect(res.headers.get("x-overflow-cost-nanousd")).toBe("360000");
  });

  test("streaming anthropic request is metered from SSE events", async () => {
    const before = balance();
    const res = await fetch(`${gwUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("content_block_delta"); // stream passed through byte-for-byte
    await Bun.sleep(30); // settle happens on stream flush
    // 500 in @ $1/M + 60 out @ $2/M = 500_000 + 120_000 = 620_000 nano
    expect(before - balance()).toBe(620_000);
  });

  test("streaming openai request is metered from usage chunk", async () => {
    const before = balance();
    const res = await fetch(`${gwUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5", stream: true, messages: [] }),
    });
    expect(res.status).toBe(200);
    await res.text();
    await Bun.sleep(30);
    // 100 in @ $1/M + 40 out @ $2/M = 100_000 + 80_000 = 180_000 nano
    expect(before - balance()).toBe(180_000);
  });

  test("usage events ledger has matching rows", async () => {
    const rows = gw.db
      .query("SELECT requested_model, served_model, cost_nano FROM usage_events ORDER BY id")
      .all() as any[];
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.cost_nano)).toEqual([360_000, 620_000, 180_000]);
    expect(rows.every((r) => r.served_model === "pool-model")).toBe(true);
  });

  test("drained key gets 402 on the next request", async () => {
    gw.db.query("UPDATE api_keys SET balance_nano = 0 WHERE id = ?").run(keyId);
    const res = await fetch(`${gwUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5", messages: [] }),
    });
    expect(res.status).toBe(402);
  });
});

describe("introspection", () => {
  test("/v1/models lists pool models with pricing", async () => {
    const res = await fetch(`${gwUrl}/v1/models`);
    const body: any = await res.json();
    expect(body.data[0].id).toBe("pool-model");
    expect(body.data[0].pricing_usd_per_m.output).toBe(2.0);
  });

  test("/v1/key reports balance", async () => {
    const res = await fetch(`${gwUrl}/v1/key`, { headers: { "x-api-key": apiKey } });
    const body: any = await res.json();
    expect(body.name).toBe("tester");
    expect(body.balance_usd).toBe(0);
  });
});
