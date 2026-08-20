import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { startGateway } from "../src/index";
import { verifyStripeSignature, applyWebhookEvent } from "../src/billing";
import { openDb, createApiKey } from "../src/db";

// Mock Stripe API for checkout-session creation.
const mockStripe = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/checkout/sessions" && req.method === "POST") {
      expect(req.headers.get("authorization")).toBe("Bearer sk_test_mock");
      const params = new URLSearchParams(await req.text());
      expect(params.get("mode")).toBe("payment");
      expect(params.get("payment_method_options[card][request_three_d_secure]")).toBe("any");
      return Response.json({
        id: "cs_test_123",
        url: "https://checkout.stripe.com/pay/cs_test_123",
      });
    }
    return new Response("nope", { status: 404 });
  },
});

process.env.STRIPE_API_BASE = `http://localhost:${mockStripe.port}`;
process.env.STRIPE_SECRET_KEY = "sk_test_mock";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";

const DB = "/tmp/overflow-billing-test-" + Date.now() + ".db";
let gw: ReturnType<typeof startGateway>;
let gwUrl: string;
let apiKey: string;
let keyId: number;

beforeAll(() => {
  gw = startGateway({ port: 0, dbPath: DB });
  gwUrl = `http://localhost:${gw.server.port}`;
  const db = openDb(DB);
  const created = createApiKey(db, "buyer", "buyer@example.com");
  apiKey = created.key;
  keyId = created.id;
});

afterAll(() => {
  gw.server.stop(true);
  mockStripe.stop(true);
});

function sign(payload: string, secret = "whsec_test", ageSec = 0): string {
  const t = Math.floor(Date.now() / 1000) - ageSec;
  const v1 = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

function completedEvent(sessionId: string, cents: number): string {
  return JSON.stringify({
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        amount_total: cents,
        payment_status: "paid",
        metadata: { key_id: String(keyId) },
      },
    },
  });
}

function balance(): number {
  return (
    gw.db.query("SELECT balance_nano FROM api_keys WHERE id = ?").get(keyId) as any
  ).balance_nano;
}

describe("signup", () => {
  test("issues a key for a new email", async () => {
    const res = await fetch(`${gwUrl}/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "new@example.com" }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.key).toStartWith("ovf_");
  });

  test("rejects a duplicate email with 409", async () => {
    const res = await fetch(`${gwUrl}/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "new@example.com" }),
    });
    expect(res.status).toBe(409);
  });

  test("rejects an invalid email with 400", async () => {
    const res = await fetch(`${gwUrl}/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "not-an-email" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("checkout", () => {
  test("creates a Stripe session for a valid pack", async () => {
    const res = await fetch(`${gwUrl}/billing/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: apiKey, usd: 10 }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.url).toContain("checkout.stripe.com");
  });

  test("rejects a non-pack amount", async () => {
    const res = await fetch(`${gwUrl}/billing/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: apiKey, usd: 3 }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects an unknown key", async () => {
    const res = await fetch(`${gwUrl}/billing/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "ovf_bogus", usd: 10 }),
    });
    expect(res.status).toBe(401);
  });
});

describe("webhook", () => {
  test("signature verification accepts valid, rejects tampered and stale", () => {
    const payload = completedEvent("cs_sig", 1000);
    expect(verifyStripeSignature(payload, sign(payload), "whsec_test")).toBe(true);
    expect(verifyStripeSignature(payload + "x", sign(payload), "whsec_test")).toBe(false);
    expect(verifyStripeSignature(payload, sign(payload, "whsec_wrong"), "whsec_test")).toBe(false);
    expect(verifyStripeSignature(payload, sign(payload, "whsec_test", 600), "whsec_test")).toBe(
      false,
    );
    expect(verifyStripeSignature(payload, null, "whsec_test")).toBe(false);
  });

  test("credits the ledger on checkout.session.completed ($10 = 1e10 nano)", async () => {
    const before = balance();
    const payload = completedEvent("cs_pay_1", 1000);
    const res = await fetch(`${gwUrl}/billing/webhook`, {
      method: "POST",
      headers: { "stripe-signature": sign(payload) },
      body: payload,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).credited).toBe(true);
    expect(balance() - before).toBe(10_000_000_000);
  });

  test("is idempotent: Stripe retries never double-credit", async () => {
    const before = balance();
    const payload = completedEvent("cs_pay_1", 1000); // same session id as above
    const res = await fetch(`${gwUrl}/billing/webhook`, {
      method: "POST",
      headers: { "stripe-signature": sign(payload) },
      body: payload,
    });
    expect(((await res.json()) as any).credited).toBe(false);
    expect(balance()).toBe(before);
  });

  test("rejects a bad signature with 400", async () => {
    const payload = completedEvent("cs_pay_2", 1000);
    const res = await fetch(`${gwUrl}/billing/webhook`, {
      method: "POST",
      headers: { "stripe-signature": sign(payload, "whsec_wrong") },
      body: payload,
    });
    expect(res.status).toBe(400);
  });

  test("ignores unpaid sessions", () => {
    const event = JSON.parse(completedEvent("cs_unpaid", 1000));
    event.data.object.payment_status = "unpaid";
    expect(applyWebhookEvent(gw.db, event).credited).toBe(false);
  });
});

describe("console endpoints", () => {
  test("/v1/usage returns totals for the key", async () => {
    const res = await fetch(`${gwUrl}/v1/usage`, { headers: { "x-api-key": apiKey } });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.totals.requests).toBe(0);
    expect(Array.isArray(body.events)).toBe(true);
  });

  test("dashboard is served at /", async () => {
    const res = await fetch(`${gwUrl}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("overflow");
  });
});
