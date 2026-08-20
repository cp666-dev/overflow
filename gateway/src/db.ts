import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";

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
  const db = new Database(path ?? process.env.OVERFLOW_DB ?? "data/overflow.db", {
    create: true,
  });
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
  `);
  return db;
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Creates a key and returns the plaintext once. Only the hash is stored. */
export function createApiKey(db: Database, name: string): { key: string; id: number } {
  const key = "ovf_" + randomBytes(24).toString("hex");
  const row = db
    .query("INSERT INTO api_keys (key_hash, name) VALUES (?, ?) RETURNING id")
    .get(hashKey(key), name) as { id: number };
  return { key, id: row.id };
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
