// Live registry of connected seller workers and the WebSocket control protocol.
//
// A worker connects OUT to the gateway (works behind home NAT), authenticates
// with its one-time registration token, passes a canary, then serves inference
// requests dispatched over the same socket. The durable listing state (cap,
// pricing, earnings) lives in the DB (marketplace.ts); this module owns only
// the in-memory socket and per-request correlation.
//
// Wire messages are JSON. Worker->gateway: register, pong, chunk, done, error.
// Gateway->worker: registered, rejected, ping, infer, canary, revoke.

import type { Database } from "bun:sqlite";
import type { ServerWebSocket } from "bun";
import {
  isServable,
  setWorkerStatus,
  workerByRegToken,
  workerById,
  type WorkerListing,
} from "./marketplace";

export const CANARY_PROMPT = "Reply with the single word: pong";
const REQUEST_TIMEOUT_MS = 120_000;

export interface WorkerSocketData {
  kind: "worker";
  workerId?: number;
}

interface PendingRequest {
  controller: ReadableStreamDefaultController<any>;
  usageResolve: (u: { prompt_tokens: number; completion_tokens: number; model: string }) => void;
  usageReject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  seenModel?: string;
}

export interface Connected {
  ws: ServerWebSocket<WorkerSocketData>;
  listing: WorkerListing;
  pending: Map<string, PendingRequest>;
  reqCounter: number;
  healthy: boolean;
}

export interface DispatchHandle {
  /** Stream of OpenAI-style chunk objects; closes on done, errors on failure. */
  chunks: ReadableStream<any>;
  /** Resolves with token usage + the model the worker actually reported. */
  usage: Promise<{ prompt_tokens: number; completion_tokens: number; model: string }>;
}

export class WorkerRegistry {
  private byId = new Map<number, Connected>();

  constructor(private db: Database) {}

  /** Cheapest servable worker for a requested model, or null. */
  pick(requestedModel: string, now: number): Connected | null {
    let best: Connected | null = null;
    for (const c of this.byId.values()) {
      if (!c.healthy) continue;
      // Re-read the authoritative listing (cap counter changes as it serves).
      const fresh = workerById(this.db, c.listing.id);
      if (!fresh || !isServable(fresh, now)) continue;
      c.listing = fresh;
      if (fresh.pool_model !== requestedModel && !modelMatches(fresh.pool_model, requestedModel))
        continue;
      if (!best || cheaper(fresh, best.listing)) best = c;
    }
    return best;
  }

  has(workerId: number): boolean {
    return this.byId.has(workerId);
  }

  connectedCount(): number {
    return this.byId.size;
  }

  /** Dispatch an inference (or canary) request to a specific connected worker. */
  dispatch(c: Connected, body: any, kind: "infer" | "canary" = "infer"): DispatchHandle {
    const id = `r${++c.reqCounter}`;
    let usageResolve!: PendingRequest["usageResolve"];
    let usageReject!: PendingRequest["usageReject"];
    const usage = new Promise<{ prompt_tokens: number; completion_tokens: number; model: string }>(
      (res, rej) => {
        usageResolve = res;
        usageReject = rej;
      },
    );

    const chunks = new ReadableStream<any>({
      start: (controller) => {
        const timer = setTimeout(() => {
          this.fail(c, id, new Error("worker request timed out"));
          c.healthy = false;
        }, REQUEST_TIMEOUT_MS);
        c.pending.set(id, { controller, usageResolve, usageReject, timer });
        c.ws.send(JSON.stringify({ t: kind, id, body }));
      },
      cancel: () => {
        const p = c.pending.get(id);
        if (p) {
          clearTimeout(p.timer);
          c.pending.delete(id);
        }
      },
    });

    return { chunks, usage };
  }

  // ---- socket lifecycle ----

  handleMessage(ws: ServerWebSocket<WorkerSocketData>, raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.t === "register") return void this.register(ws, msg);

    const c = ws.data.workerId != null ? this.byId.get(ws.data.workerId) : undefined;
    if (!c) return;
    switch (msg.t) {
      case "pong":
        c.healthy = true;
        break;
      case "chunk": {
        const p = c.pending.get(msg.id);
        if (!p) return;
        if (msg.data?.model) p.seenModel = msg.data.model;
        p.controller.enqueue(msg.data);
        break;
      }
      case "done": {
        const p = c.pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        p.controller.close();
        p.usageResolve({
          prompt_tokens: msg.usage?.prompt_tokens ?? 0,
          completion_tokens: msg.usage?.completion_tokens ?? 0,
          model: p.seenModel ?? msg.usage?.model ?? "",
        });
        c.pending.delete(msg.id);
        break;
      }
      case "error":
        this.fail(c, msg.id, new Error(msg.message ?? "worker error"));
        break;
    }
  }

  private async register(ws: ServerWebSocket<WorkerSocketData>, msg: any): Promise<void> {
    const listing = workerByRegToken(this.db, String(msg.regToken ?? ""));
    if (!listing) {
      ws.send(JSON.stringify({ t: "rejected", reason: "invalid registration token" }));
      ws.close();
      return;
    }
    if (listing.status === "revoked") {
      ws.send(JSON.stringify({ t: "rejected", reason: "listing revoked" }));
      ws.close();
      return;
    }
    const c: Connected = { ws, listing, pending: new Map(), reqCounter: 0, healthy: true };
    ws.data.workerId = listing.id;
    this.byId.set(listing.id, c);

    // Canary: the worker must stream back non-empty text whose model id matches
    // what it registered. A worker secretly serving a smaller/different model
    // reports a different id here and is rejected.
    try {
      const canary = this.dispatch(
        c,
        {
          model: listing.upstream_model,
          messages: [{ role: "user", content: CANARY_PROMPT }],
          max_tokens: 16,
          stream: true,
        },
        "canary",
      );
      let text = "";
      const reader = canary.chunks.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += value?.choices?.[0]?.delta?.content ?? "";
      }
      const u = await canary.usage;
      if (u.model && u.model !== listing.upstream_model) {
        this.rejectWorker(c, `model mismatch: registered ${listing.upstream_model}, served ${u.model}`);
        return;
      }
      if (text.trim().length === 0) {
        this.rejectWorker(c, "canary produced no output");
        return;
      }
    } catch (e) {
      this.rejectWorker(c, `canary failed: ${e}`);
      return;
    }

    setWorkerStatus(this.db, listing.id, "active");
    c.listing = workerById(this.db, listing.id)!;
    ws.send(JSON.stringify({ t: "registered", workerId: listing.id, poolModel: listing.pool_model }));
  }

  private rejectWorker(c: Connected, reason: string): void {
    setWorkerStatus(this.db, c.listing.id, "rejected");
    c.ws.send(JSON.stringify({ t: "rejected", reason }));
    c.ws.close();
    this.byId.delete(c.listing.id);
  }

  private fail(c: Connected, id: string, err: Error): void {
    const p = c.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    try {
      p.controller.error(err);
    } catch {}
    p.usageReject(err);
    c.pending.delete(id);
  }

  /** Tell a worker to stop and drop it from the pool (seller revoke). */
  revoke(workerId: number): void {
    const c = this.byId.get(workerId);
    setWorkerStatus(this.db, workerId, "revoked");
    if (c) {
      try {
        c.ws.send(JSON.stringify({ t: "revoke" }));
        c.ws.close();
      } catch {}
      for (const [, p] of c.pending) {
        clearTimeout(p.timer);
        try {
          p.controller.error(new Error("worker revoked"));
        } catch {}
      }
      this.byId.delete(workerId);
    }
  }

  handleClose(ws: ServerWebSocket<WorkerSocketData>): void {
    const id = ws.data.workerId;
    if (id == null) return;
    const c = this.byId.get(id);
    if (c) {
      for (const [, p] of c.pending) {
        clearTimeout(p.timer);
        try {
          p.controller.error(new Error("worker disconnected"));
        } catch {}
      }
      this.byId.delete(id);
    }
    // Listing stays as-is (active→still active in DB) but with no socket it is
    // unpickable; a reconnect re-registers. Mark non-terminal statuses offline.
    const listing = workerById(this.db, id);
    if (listing && listing.status === "active") setWorkerStatus(this.db, id, "offline");
  }

  /** Ping all workers; callers run this on an interval for liveness. */
  pingAll(): void {
    for (const c of this.byId.values()) {
      c.healthy = false; // flipped back true on pong
      try {
        c.ws.send(JSON.stringify({ t: "ping" }));
      } catch {}
    }
  }
}

function cheaper(a: WorkerListing, b: WorkerListing): boolean {
  return a.ask_in_per_m + a.ask_out_per_m < b.ask_in_per_m + b.ask_out_per_m;
}

/** A worker for pool model X also serves requests for aliases of X. */
function modelMatches(poolModel: string, requested: string): boolean {
  const r = requested.toLowerCase();
  const p = poolModel.toLowerCase();
  if (r === p) return true;
  // Coarse family match so e.g. a "qwen3-coder" worker catches "claude-*" coding
  // fallback traffic routed by family. Kept intentionally conservative.
  if (p.includes("qwen") && (r.startsWith("claude") || r.startsWith("qwen"))) return true;
  if (p.includes("deepseek") && (r.startsWith("gpt") || r.startsWith("deepseek"))) return true;
  return false;
}
