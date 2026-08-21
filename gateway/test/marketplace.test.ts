import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startGateway } from "../src/index";
import { createApiKey, addCredit, openDb } from "../src/db";
import { createWorkerListing, workerById, TAKE_RATE } from "../src/marketplace";
import type { GatewayConfig } from "../src/config";

// A mock seller worker: connects over WS, registers, and answers infer/canary
// requests by streaming a couple of chunks. `servedModel` lets us simulate a
// cheater that serves a different model than it registered.
class MockWorker {
  ws: WebSocket;
  ready: Promise<{ ok: boolean; reason?: string }>;
  constructor(
    gwUrl: string,
    private regToken: string,
    private servedModel: string,
    private reply = "pong from the pool",
  ) {
    this.ws = new WebSocket(gwUrl.replace("http", "ws") + "/worker/connect");
    this.ready = new Promise((resolve) => {
      this.ws.addEventListener("open", () => {
        this.send({ t: "register", regToken: this.regToken, upstreamModel: this.servedModel });
      });
      this.ws.addEventListener("message", (ev) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.t === "registered") resolve({ ok: true });
        else if (msg.t === "rejected") resolve({ ok: false, reason: msg.reason });
        else if (msg.t === "ping") this.send({ t: "pong" });
        else if (msg.t === "infer" || msg.t === "canary") this.answer(msg.id, msg.t);
      });
    });
  }
  private send(o: any) {
    this.ws.send(JSON.stringify(o));
  }
  private answer(id: string, kind: string) {
    // canary gets a fixed short reply; infer echoes the reply text.
    const text = kind === "canary" ? "pong" : this.reply;
    this.send({
      t: "chunk",
      id,
      data: { model: this.servedModel, choices: [{ delta: { content: text } }] },
    });
    this.send({
      t: "done",
      id,
      usage: { prompt_tokens: 10, completion_tokens: 5, model: this.servedModel },
    });
  }
  close() {
    this.ws.close();
  }
}

// No HTTP upstreams: forces every request to resolve via the worker pool (or 404).
const emptyConfig: GatewayConfig = { upstreams: [], routes: [] };

const DB = "/tmp/overflow-mkt-test-" + Date.now() + ".db";
let gw: ReturnType<typeof startGateway>;
let gwUrl: string;
let buyerKey: string;
let buyerId: number;
let sellerId: number;
let sellerKey: string;

beforeAll(() => {
  gw = startGateway({ port: 0, dbPath: DB, config: emptyConfig });
  gwUrl = `http://localhost:${gw.server.port}`;
  const db = openDb(DB);
  const buyer = createApiKey(db, "buyer", "buyer@mkt.dev");
  buyerKey = buyer.key;
  buyerId = buyer.id;
  addCredit(db, buyerId, 5_000_000_000); // $5
  const seller = createApiKey(db, "seller", "seller@mkt.dev");
  sellerId = seller.id;
  sellerKey = seller.key;
});

afterAll(() => {
  gw.server.stop(true);
});

function newListing(model = "qwen3-coder", cap = 1000, askIn = 0.4, askOut = 1.6) {
  return createWorkerListing(gw.db, sellerId, {
    poolModel: model,
    upstreamModel: model + "-v1",
    askInPerM: askIn,
    askOutPerM: askOut,
    tokenCap: cap,
  });
}

async function chat(model: string, key = buyerKey) {
  return fetch(`${gwUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });
}

describe("worker registration + canary", () => {
  test("an honest worker registers and passes canary", async () => {
    const { regToken, id } = newListing();
    const w = new MockWorker(gwUrl, regToken, "qwen3-coder-v1");
    const res = await w.ready;
    expect(res.ok).toBe(true);
    expect(workerById(gw.db, id)!.status).toBe("active");
    w.close();
    await Bun.sleep(20);
  });

  test("a cheating worker (wrong served model) is rejected by canary", async () => {
    const { regToken, id } = newListing();
    // Registered upstream is qwen3-coder-v1 but it actually serves a tiny model.
    const w = new MockWorker(gwUrl, regToken, "sneaky-tiny-model");
    const res = await w.ready;
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("model mismatch");
    expect(workerById(gw.db, id)!.status).toBe("rejected");
    w.close();
  });

  test("an invalid registration token is rejected", async () => {
    const w = new MockWorker(gwUrl, "ovfw_not_a_real_token", "whatever");
    const res = await w.ready;
    expect(res.ok).toBe(false);
    w.close();
  });
});

describe("serving + dual metering", () => {
  test("buyer debited and seller credited on a worker-served request", async () => {
    const { regToken, id } = newListing("qwen3-coder", 1000, 0.4, 1.6);
    const w = new MockWorker(gwUrl, regToken, "qwen3-coder-v1");
    expect((await w.ready).ok).toBe(true);

    const balBefore = (
      gw.db.query("SELECT balance_nano b FROM api_keys WHERE id = ?").get(buyerId) as any
    ).b;
    const res = await chat("qwen3-coder");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-overflow-marketplace")).toBe("1");
    expect(res.headers.get("x-overflow-upstream")).toBe(`worker:${id}`);
    const body: any = await res.json();
    expect(body.choices[0].message.content).toBe("pong from the pool");

    // 10 in @ $0.40/M + 5 out @ $1.60/M = seller ask.
    const sellerEarn = Math.round(10 * 0.4 * 1000 + 5 * 1.6 * 1000); // nano
    // buyer pays ask grossed up by the take.
    const buyerCost = Math.round(
      10 * (0.4 / (1 - TAKE_RATE)) * 1000 + 5 * (1.6 / (1 - TAKE_RATE)) * 1000,
    );
    const worker = workerById(gw.db, id)!;
    expect(worker.earnings_nano).toBe(sellerEarn);
    expect(worker.tokens_used).toBe(15);

    const balAfter = (
      gw.db.query("SELECT balance_nano b FROM api_keys WHERE id = ?").get(buyerId) as any
    ).b;
    expect(balBefore - balAfter).toBe(buyerCost);
    expect(Number(res.headers.get("x-overflow-cost-nanousd"))).toBe(buyerCost);

    // platform take is the positive spread.
    expect(buyerCost).toBeGreaterThan(sellerEarn);
    w.close();
    await Bun.sleep(20);
  });
});

describe("authoritative token cap", () => {
  test("routing stops once the cap is reached and listing flips to exhausted", async () => {
    // cap = 15 tokens; one request uses exactly 15, so the next must not route.
    const { regToken, id } = newListing("capmodel", 15);
    const w = new MockWorker(gwUrl, regToken, "capmodel-v1");
    expect((await w.ready).ok).toBe(true);

    const first = await chat("capmodel");
    expect(first.status).toBe(200);
    expect(workerById(gw.db, id)!.status).toBe("exhausted");

    // No worker servable now, and no HTTP upstream configured -> 404.
    const second = await chat("capmodel");
    expect(second.status).toBe(404);
    w.close();
    await Bun.sleep(20);
  });
});

describe("revocation", () => {
  test("revoke removes the worker from the pool immediately", async () => {
    const { regToken, id } = newListing("revmodel", 100000);
    const w = new MockWorker(gwUrl, regToken, "revmodel-v1");
    expect((await w.ready).ok).toBe(true);
    expect(gw.registry.has(id)).toBe(true);

    const res = await fetch(`${gwUrl}/seller/listings/${id}/revoke`, {
      method: "POST",
      headers: { "x-api-key": sellerKey },
    });
    expect(res.status).toBe(200);
    await Bun.sleep(20);
    expect(gw.registry.has(id)).toBe(false);
    expect(workerById(gw.db, id)!.status).toBe("revoked");

    const after = await chat("revmodel");
    expect(after.status).toBe(404); // nothing serves it now
    w.close();
  });
});

describe("seller listing endpoint", () => {
  test("creating a listing over HTTP returns a one-time reg token", async () => {
    const res = await fetch(`${gwUrl}/seller/listings`, {
      method: "POST",
      headers: { "x-api-key": sellerKey, "content-type": "application/json" },
      body: JSON.stringify({
        poolModel: "glm-4.6",
        upstreamModel: "glm-4.6",
        askInPerM: 0.5,
        askOutPerM: 2,
        tokenCap: 1_000_000,
      }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.regToken).toStartWith("ovfw_");
  });

  test("invalid listing is rejected", async () => {
    const res = await fetch(`${gwUrl}/seller/listings`, {
      method: "POST",
      headers: { "x-api-key": sellerKey, "content-type": "application/json" },
      body: JSON.stringify({ poolModel: "", tokenCap: -1 }),
    });
    expect(res.status).toBe(400);
  });
});
