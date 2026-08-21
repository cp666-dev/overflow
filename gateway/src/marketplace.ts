// Marketplace data layer: seller listings (workers), the authoritative token
// cap/earnings ledger, and payout accounting. The live WebSocket for each
// worker lives in the registry (workers-registry.ts); this module owns the
// durable state in SQLite.

import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { sha256hex } from "./db";

/** Platform commission. Buyer pays the seller's ask grossed up by this rate. */
export const TAKE_RATE = 0.2;

export interface WorkerListing {
  id: number;
  seller_key_id: number;
  pool_model: string;
  upstream_model: string;
  ask_in_per_m: number;
  ask_out_per_m: number;
  token_cap: number;
  tokens_used: number;
  window_end: string | null;
  status: string;
  earnings_nano: number;
  created_at: string;
}

export interface NewListing {
  poolModel: string;
  upstreamModel: string;
  askInPerM: number;
  askOutPerM: number;
  tokenCap: number;
  /** ISO datetime string, or null for open-ended. */
  windowEnd?: string | null;
}

/** Create a listing and return a one-time registration token (shown once). */
export function createWorkerListing(
  db: Database,
  sellerKeyId: number,
  l: NewListing,
): { id: number; regToken: string } {
  const regToken = "ovfw_" + randomBytes(24).toString("hex");
  const row = db
    .query(
      `INSERT INTO workers
        (seller_key_id, reg_token_hash, pool_model, upstream_model,
         ask_in_per_m, ask_out_per_m, token_cap, window_end)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      sellerKeyId,
      sha256hex(regToken),
      l.poolModel,
      l.upstreamModel,
      l.askInPerM,
      l.askOutPerM,
      l.tokenCap,
      l.windowEnd ?? null,
    ) as { id: number };
  return { id: row.id, regToken };
}

export function workerByRegToken(db: Database, token: string): WorkerListing | null {
  if (!token.startsWith("ovfw_")) return null;
  return (
    (db
      .query("SELECT * FROM workers WHERE reg_token_hash = ?")
      .get(sha256hex(token)) as WorkerListing | null) ?? null
  );
}

export function workerById(db: Database, id: number): WorkerListing | null {
  return (db.query("SELECT * FROM workers WHERE id = ?").get(id) as WorkerListing | null) ?? null;
}

export function listingsForSeller(db: Database, sellerKeyId: number): WorkerListing[] {
  return db
    .query("SELECT * FROM workers WHERE seller_key_id = ? ORDER BY id DESC")
    .all(sellerKeyId) as WorkerListing[];
}

export function setWorkerStatus(db: Database, id: number, status: string): void {
  db.query("UPDATE workers SET status = ? WHERE id = ?").run(status, id);
}

/** A listing is servable if active, inside its window, and under its cap. */
export function isServable(w: WorkerListing, now: number): boolean {
  if (w.status !== "active") return false;
  if (w.tokens_used >= w.token_cap) return false;
  if (w.window_end && new Date(w.window_end).getTime() <= now) return false;
  return true;
}

/** Buyer price ($/M) derived from a seller ask, grossed up by the platform take. */
export function buyerPerM(askPerM: number): number {
  return askPerM / (1 - TAKE_RATE);
}

export interface MarketplaceSettlement {
  buyerBalanceNano: number;
  tokensUsed: number;
  capReached: boolean;
  buyerCostNano: number;
  sellerEarnNano: number;
}

/**
 * One transaction: append the usage event, debit the buyer at the grossed-up
 * price, credit the worker's earnings at the seller's ask, and advance the
 * authoritative token counter. Returns whether the cap is now reached so the
 * caller can flip the listing to `exhausted`.
 */
export function settleMarketplaceUsage(
  db: Database,
  args: {
    buyerKeyId: number;
    worker: WorkerListing;
    requestedModel: string;
    inTokens: number;
    outTokens: number;
  },
): MarketplaceSettlement {
  const { worker, inTokens, outTokens } = args;
  const sellerEarnNano = Math.round(
    inTokens * worker.ask_in_per_m * 1000 + outTokens * worker.ask_out_per_m * 1000,
  );
  const buyerCostNano = Math.round(
    inTokens * buyerPerM(worker.ask_in_per_m) * 1000 +
      outTokens * buyerPerM(worker.ask_out_per_m) * 1000,
  );

  const tx = db.transaction(() => {
    db.query(
      `INSERT INTO usage_events
        (key_id, shape, requested_model, served_model, upstream, in_tokens, out_tokens, cost_nano)
       VALUES (?, 'openai', ?, ?, ?, ?, ?, ?)`,
    ).run(
      args.buyerKeyId,
      args.requestedModel,
      worker.pool_model,
      `worker:${worker.id}`,
      inTokens,
      outTokens,
      buyerCostNano,
    );
    db.query("UPDATE api_keys SET balance_nano = balance_nano - ? WHERE id = ?").run(
      buyerCostNano,
      args.buyerKeyId,
    );
    db.query(
      "UPDATE workers SET tokens_used = tokens_used + ?, earnings_nano = earnings_nano + ? WHERE id = ?",
    ).run(inTokens + outTokens, sellerEarnNano, worker.id);
    const after = db
      .query("SELECT tokens_used, token_cap FROM workers WHERE id = ?")
      .get(worker.id) as { tokens_used: number; token_cap: number };
    const balance = (
      db.query("SELECT balance_nano FROM api_keys WHERE id = ?").get(args.buyerKeyId) as {
        balance_nano: number;
      }
    ).balance_nano;
    const capReached = after.tokens_used >= after.token_cap;
    if (capReached) setWorkerStatus(db, worker.id, "exhausted");
    return { balance, tokensUsed: after.tokens_used, capReached };
  });
  const r = tx();
  return {
    buyerBalanceNano: r.balance,
    tokensUsed: r.tokensUsed,
    capReached: r.capReached,
    buyerCostNano,
    sellerEarnNano,
  };
}

export interface SellerSummary {
  earnings_nano: number;
  paid_out_nano: number;
  available_nano: number;
  active_workers: number;
  stripe_connect_id: string | null;
}

/** Earnings across all a seller's workers, minus what's been paid out. */
export function sellerSummary(db: Database, sellerKeyId: number): SellerSummary {
  const earned = (
    db.query("SELECT COALESCE(SUM(earnings_nano),0) e FROM workers WHERE seller_key_id = ?").get(
      sellerKeyId,
    ) as { e: number }
  ).e;
  const active = (
    db
      .query("SELECT COUNT(*) c FROM workers WHERE seller_key_id = ? AND status = 'active'")
      .get(sellerKeyId) as { c: number }
  ).c;
  const acct = db
    .query("SELECT stripe_connect_id, paid_out_nano FROM api_keys WHERE id = ?")
    .get(sellerKeyId) as { stripe_connect_id: string | null; paid_out_nano: number };
  return {
    earnings_nano: earned,
    paid_out_nano: acct.paid_out_nano,
    available_nano: earned - acct.paid_out_nano,
    active_workers: active,
    stripe_connect_id: acct.stripe_connect_id,
  };
}
