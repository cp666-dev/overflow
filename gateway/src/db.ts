import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface ApiKey {
  id: number;
  name: string;
  balance_nano: number;
  created_at: string;
}

export interface UsageEvent {
  id: number;
  key_id: number;
  ts: string;
  shape: string;
  requested_model: string;
  served_model: string;
  upstream: string;
  in_tokens: number;
  out_tokens: number;
  cost_nano: number;
}

export function openDb(path?: string): Database {
  const file = path ?? process.env.OVERFLOW_DB ?? "data/overflow.db";
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_hash TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      balance_nano INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_id INTEGER NOT NULL REFERENCES api_keys(id),
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      shape TEXT NOT NULL,
      requested_model TEXT NOT NULL,
      served_model TEXT NOT NULL,
      upstream TEXT NOT NULL,
      in_tokens INTEGER NOT NULL,
      out_tokens INTEGER NOT NULL,
      cost_nano INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_key_ts ON usage_events(key_id, ts);
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stripe_session_id TEXT NOT NULL UNIQUE,
      key_id INTEGER NOT NULL REFERENCES api_keys(id),
      amount_cents INTEGER NOT NULL,
      credited_nano INTEGER NOT NULL,
      ts TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- A seller's capacity listing. The live socket lives in memory; this row is
    -- the durable state: pricing, the authoritative token cap/counter, window,
    -- and accrued earnings.
    CREATE TABLE IF NOT EXISTS workers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seller_key_id INTEGER NOT NULL REFERENCES api_keys(id),
      reg_token_hash TEXT NOT NULL UNIQUE,
      pool_model TEXT NOT NULL,
      upstream_model TEXT NOT NULL,
      ask_in_per_m REAL NOT NULL,
      ask_out_per_m REAL NOT NULL,
      token_cap INTEGER NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      window_end TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      earnings_nano INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_workers_seller ON workers(seller_key_id);
    CREATE TABLE IF NOT EXISTS payouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seller_key_id INTEGER NOT NULL REFERENCES api_keys(id),
      amount_nano INTEGER NOT NULL,
      stripe_transfer_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      ts TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const cols = db.query("PRAGMA table_info(api_keys)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "email")) {
    db.exec("ALTER TABLE api_keys ADD COLUMN email TEXT");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_keys_email ON api_keys(email)");
  }
  if (!cols.some((c) => c.name === "stripe_connect_id")) {
    db.exec("ALTER TABLE api_keys ADD COLUMN stripe_connect_id TEXT");
    db.exec("ALTER TABLE api_keys ADD COLUMN paid_out_nano INTEGER NOT NULL DEFAULT 0");
  }
  return db;
}

export function sha256hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function hashKey(key: string): string {
  return sha256hex(key);
}

/** Creates a key and returns the plaintext once. Only the hash is stored. */
export function createApiKey(
  db: Database,
  name: string,
  email?: string,
): { key: string; id: number } {
  const key = "ovf_" + randomBytes(24).toString("hex");
  const row = db
    .query("INSERT INTO api_keys (key_hash, name, email) VALUES (?, ?, ?) RETURNING id")
    .get(hashKey(key), name, email ?? null) as { id: number };
  return { key, id: row.id };
}

export function emailExists(db: Database, email: string): boolean {
  return !!db.query("SELECT 1 FROM api_keys WHERE email = ?").get(email);
}

export interface UsageSummary {
  events: any[];
  totals: { in_tokens: number; out_tokens: number; cost_nano: number; requests: number };
}

export function usageForKey(db: Database, keyId: number, limit = 50): UsageSummary {
  const events = db
    .query(
      `SELECT ts, requested_model, served_model, upstream, in_tokens, out_tokens, cost_nano
       FROM usage_events WHERE key_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(keyId, limit) as any[];
  const totals = db
    .query(
      `SELECT COALESCE(SUM(in_tokens),0) in_tokens, COALESCE(SUM(out_tokens),0) out_tokens,
              COALESCE(SUM(cost_nano),0) cost_nano, COUNT(*) requests
       FROM usage_events WHERE key_id = ?`,
    )
    .get(keyId) as UsageSummary["totals"];
  return { events, totals };
}

export function lookupKey(db: Database, key: string): ApiKey | null {
  if (!key.startsWith("ovf_")) return null;
  return (
    (db
      .query("SELECT id, name, balance_nano, created_at FROM api_keys WHERE key_hash = ?")
      .get(hashKey(key)) as ApiKey | null) ?? null
  );
}

export function addCredit(db: Database, keyId: number, nano: number): void {
  const res = db
    .query("UPDATE api_keys SET balance_nano = balance_nano + ? WHERE id = ?")
    .run(nano, keyId);
  if (res.changes === 0) throw new Error(`no key with id ${keyId}`);
}

export interface UsageRecord {
  keyId: number;
  shape: string;
  requestedModel: string;
  servedModel: string;
  upstream: string;
  inTokens: number;
  outTokens: number;
  costNano: number;
}

/** Append the usage event and debit the balance in one transaction. */
export function recordUsage(db: Database, u: UsageRecord): number {
  const tx = db.transaction(() => {
    db.query(
      `INSERT INTO usage_events
        (key_id, shape, requested_model, served_model, upstream, in_tokens, out_tokens, cost_nano)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      u.keyId,
      u.shape,
      u.requestedModel,
      u.servedModel,
      u.upstream,
      u.inTokens,
      u.outTokens,
      u.costNano,
    );
    db.query("UPDATE api_keys SET balance_nano = balance_nano - ? WHERE id = ?").run(
      u.costNano,
      u.keyId,
    );
    return (
      db.query("SELECT balance_nano FROM api_keys WHERE id = ?").get(u.keyId) as {
        balance_nano: number;
      }
    ).balance_nano;
  });
  return tx();
}
