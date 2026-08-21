// Seller payouts via Stripe Connect Express. Same plain-HTTPS, mockable pattern
// as billing.ts (STRIPE_API_BASE points at a mock in tests). Earnings accrue on
// worker rows; a payout transfers the available balance to the seller's Connect
// account and advances their paid_out_nano watermark.

import type { Database } from "bun:sqlite";
import { sellerSummary } from "./marketplace";
import type { ApiKey } from "./db";

/** Minimum payout, in nanodollars ($5). Below this, holds until it accrues. */
export const MIN_PAYOUT_NANO = 5_000_000_000;

const stripeApi = () => process.env.STRIPE_API_BASE ?? "https://api.stripe.com";

function form(data: Record<string, string>): string {
  return new URLSearchParams(data).toString();
}

async function stripePost(path: string, data: Record<string, string>): Promise<any> {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error("payouts not configured (missing STRIPE_SECRET_KEY)");
  const res = await fetch(`${stripeApi()}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form(data),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? `stripe error ${res.status}`);
  return body;
}

/** Create (once) a Connect Express account for the seller and store its id. */
export async function createConnectAccount(
  db: Database,
  key: ApiKey & { stripe_connect_id?: string | null },
): Promise<{ accountId: string } | { error: string }> {
  const existing = db
    .query("SELECT stripe_connect_id FROM api_keys WHERE id = ?")
    .get(key.id) as { stripe_connect_id: string | null };
  if (existing?.stripe_connect_id) return { accountId: existing.stripe_connect_id };
  try {
    const acct = await stripePost("/v1/accounts", {
      type: "express",
      "capabilities[transfers][requested]": "true",
    });
    db.query("UPDATE api_keys SET stripe_connect_id = ? WHERE id = ?").run(acct.id, key.id);
    return { accountId: acct.id };
  } catch (e) {
    return { error: String(e instanceof Error ? e.message : e) };
  }
}

/** Onboarding link the seller follows to complete Connect verification. */
export async function createAccountLink(
  accountId: string,
  baseUrl: string,
): Promise<{ url: string } | { error: string }> {
  try {
    const link = await stripePost("/v1/account_links", {
      account: accountId,
      type: "account_onboarding",
      refresh_url: `${baseUrl}/?payouts=refresh`,
      return_url: `${baseUrl}/?payouts=done`,
    });
    return { url: link.url };
  } catch (e) {
    return { error: String(e instanceof Error ? e.message : e) };
  }
}

/**
 * Pay out the seller's available balance (earnings minus already paid). Records
 * a payout row and advances paid_out_nano atomically so a retry can't double-pay.
 * Real Stripe transfer is fire-and-forgettable; failure rolls the row to failed.
 */
export function requestPayout(
  db: Database,
  sellerKeyId: number,
): { paid_usd: number; payoutId: number } | { error: string } {
  const summary = sellerSummary(db, sellerKeyId);
  if (!summary.stripe_connect_id) {
    return { error: "Connect onboarding not complete. Set up payouts first." };
  }
  if (summary.available_nano < MIN_PAYOUT_NANO) {
    return { error: `Minimum payout is $${MIN_PAYOUT_NANO / 1e9}. Keep earning.` };
  }

  const amount = summary.available_nano;
  const tx = db.transaction(() => {
    // Re-check inside the tx to avoid a race double-advancing the watermark.
    const s = sellerSummary(db, sellerKeyId);
    if (s.available_nano < MIN_PAYOUT_NANO) return null;
    const row = db
      .query(
        "INSERT INTO payouts (seller_key_id, amount_nano, status) VALUES (?, ?, 'pending') RETURNING id",
      )
      .get(sellerKeyId, s.available_nano) as { id: number };
    db.query("UPDATE api_keys SET paid_out_nano = paid_out_nano + ? WHERE id = ?").run(
      s.available_nano,
      sellerKeyId,
    );
    return { id: row.id, amount: s.available_nano };
  });
  const created = tx();
  if (!created) return { error: "Balance moved below the minimum; try again." };

  // Kick off the Stripe transfer (cents). Errors are logged, not surfaced: the
  // payout row records intent; reconciliation handles transfer failures.
  const cents = Math.floor(created.amount / 1e7);
  stripePost("/v1/transfers", {
    amount: String(cents),
    currency: "usd",
    destination: summary.stripe_connect_id,
  })
    .then((t) =>
      db
        .query("UPDATE payouts SET status = 'paid', stripe_transfer_id = ? WHERE id = ?")
        .run(t.id, created.id),
    )
    .catch(() => db.query("UPDATE payouts SET status = 'failed' WHERE id = ?").run(created.id));

  return { paid_usd: amount / 1e9, payoutId: created.id };
}
