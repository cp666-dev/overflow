// Stripe integration via plain HTTPS (no SDK): Checkout Sessions for prepaid
// credit packs, and webhook verification that credits the ledger exactly once
// per session. Requires STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";
import { addCredit } from "./db";

/** Credit packs. Minimum $10: Stripe's 2.9% + 30c makes smaller packs uneconomic. */
export const PACKS = [
  { usd: 10, label: "$10 pack" },
  { usd: 25, label: "$25 pack" },
  { usd: 50, label: "$50 pack" },
] as const;

const stripeApi = () => process.env.STRIPE_API_BASE ?? "https://api.stripe.com";

function form(data: Record<string, string>): string {
  return new URLSearchParams(data).toString();
}

export async function createCheckoutSession(
  keyId: number,
  usd: number,
  baseUrl: string,
): Promise<{ url: string } | { error: string }> {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return { error: "billing is not configured (missing STRIPE_SECRET_KEY)" };
  if (!PACKS.some((p) => p.usd === usd)) return { error: "invalid pack" };

  const res = await fetch(`${stripeApi()}/v1/checkout/sessions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form({
      mode: "payment",
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": String(usd * 100),
      "line_items[0][price_data][product_data][name]": `Overflow credits: $${usd} pack`,
      "payment_method_options[card][request_three_d_secure]": "any",
      "metadata[key_id]": String(keyId),
      success_url: `${baseUrl}/?topup=success`,
      cancel_url: `${baseUrl}/?topup=cancelled`,
    }),
  });
  const body: any = await res.json();
  if (!res.ok) return { error: body?.error?.message ?? `stripe error ${res.status}` };
  return { url: body.url };
}

/** Verify a Stripe webhook signature (t=...,v1=... HMAC-SHA256 over `${t}.${payload}`). */
export function verifyStripeSignature(
  payload: string,
  sigHeader: string | null,
  secret: string,
  toleranceSec = 300,
): boolean {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(
    sigHeader.split(",").map((kv) => kv.split("=", 2) as [string, string]),
  );
  const t = parts["t"];
  const v1 = parts["v1"];
  if (!t || !v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(v1);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Handle a verified webhook event. Credits the key from session metadata,
 * idempotently: a session id is only ever credited once, no matter how many
 * times Stripe retries delivery.
 */
export function applyWebhookEvent(db: Database, event: any): { credited: boolean } {
  if (event?.type !== "checkout.session.completed") return { credited: false };
  const session = event.data?.object;
  const keyId = Number(session?.metadata?.key_id);
  const cents = Number(session?.amount_total);
  if (!keyId || !cents || session?.payment_status !== "paid") return { credited: false };

  const nano = cents * 10_000_000; // 1 cent = 1e7 nanodollars
  const tx = db.transaction(() => {
    const dup = db
      .query("SELECT 1 FROM payments WHERE stripe_session_id = ?")
      .get(String(session.id));
    if (dup) return false;
    db.query(
      "INSERT INTO payments (stripe_session_id, key_id, amount_cents, credited_nano) VALUES (?, ?, ?, ?)",
    ).run(String(session.id), keyId, cents, nano);
    addCredit(db, keyId, nano);
    return true;
  });
  return { credited: tx() };
}
