import { openDb, lookupKey, createApiKey, emailExists, usageForKey } from "./db";
import { defaultConfig, findRoute, upstreamFor, type GatewayConfig } from "./config";
import { handleCompletion } from "./proxy";
import { applyWebhookEvent, createCheckoutSession, verifyStripeSignature, PACKS } from "./billing";
import { WorkerRegistry, type WorkerSocketData } from "./workers-registry";
import { serveFromWorker } from "./worker-proxy";
import {
  createWorkerListing,
  listingsForSeller,
  sellerSummary,
  workerById,
  type NewListing,
} from "./marketplace";
import { createConnectAccount, createAccountLink, requestPayout } from "./payouts";

const DASHBOARD = new URL("../public/index.html", import.meta.url).pathname;

// Naive per-IP signup throttle: 5 signups per hour per address.
const signupHits = new Map<string, number[]>();
function signupAllowed(ip: string): boolean {
  const now = Date.now();
  const hits = (signupHits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  hits.push(now);
  signupHits.set(ip, hits);
  return hits.length <= 5;
}

export interface ServerOptions {
  port?: number;
  dbPath?: string;
  config?: GatewayConfig;
}

export function startGateway(opts: ServerOptions = {}) {
  const db = openDb(opts.dbPath);
  const config = opts.config ?? defaultConfig;
  const registry = new WorkerRegistry(db);

  const server = Bun.serve<WorkerSocketData>({
    port: opts.port ?? Number(process.env.OVERFLOW_PORT ?? 8484),
    idleTimeout: 240,
    websocket: {
      open() {},
      message(ws, message) {
        registry.handleMessage(ws, typeof message === "string" ? message : message.toString());
      },
      close(ws) {
        registry.handleClose(ws);
      },
    },
    async fetch(req, srv) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/healthz") return Response.json({ ok: true });

      // ---- worker control channel (outbound WS from seller workers) ----
      if (path === "/worker/connect") {
        if (srv.upgrade(req, { data: { kind: "worker" } as WorkerSocketData })) return undefined;
        return new Response("expected websocket upgrade", { status: 426 });
      }

      if (path === "/" && req.method === "GET") {
        return new Response(Bun.file(DASHBOARD), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      // ---- signup: email in, API key out (shown once) ----
      if (path === "/signup" && req.method === "POST") {
        const ip = srv.requestIP(req)?.address ?? "unknown";
        if (!signupAllowed(ip)) {
          return Response.json({ error: { type: "rate_limited" } }, { status: 429 });
        }
        const body: any = await req.json().catch(() => null);
        const email = String(body?.email ?? "").trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return Response.json(
            { error: { type: "invalid_email", message: "Enter a valid email." } },
            { status: 400 },
          );
        }
        if (emailExists(db, email)) {
          return Response.json(
            {
              error: {
                type: "email_exists",
                message: "That email already has a key. Contact us if you lost it.",
              },
            },
            { status: 409 },
          );
        }
        const { key } = createApiKey(db, email.split("@")[0]!, email);
        return Response.json({ key, note: "Store this now: it is only shown once." });
      }

      // ---- billing ----
      if (path === "/billing/packs" && req.method === "GET") {
        return Response.json({ packs: PACKS });
      }
      if (path === "/billing/checkout" && req.method === "POST") {
        const body: any = await req.json().catch(() => null);
        const key = lookupKey(db, String(body?.key ?? ""));
        if (!key) return authError();
        const baseUrl = process.env.PUBLIC_BASE_URL ?? url.origin;
        const result = await createCheckoutSession(key.id, Number(body?.usd), baseUrl);
        if ("error" in result) {
          return Response.json({ error: { type: "billing_error", message: result.error } }, {
            status: 400,
          });
        }
        return Response.json(result);
      }
      if (path === "/billing/webhook" && req.method === "POST") {
        const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
        if (!whSecret) return new Response("webhook not configured", { status: 503 });
        const payload = await req.text();
        if (!verifyStripeSignature(payload, req.headers.get("stripe-signature"), whSecret)) {
          return new Response("bad signature", { status: 400 });
        }
        const { credited } = applyWebhookEvent(db, JSON.parse(payload));
        return Response.json({ received: true, credited });
      }

      if (path === "/v1/models" && req.method === "GET") {
        return Response.json({
          object: "list",
          data: config.routes.map((r) => ({
            id: r.pool,
            object: "model",
            owned_by: "overflow-pool",
            pricing_usd_per_m: { input: r.inPerM, output: r.outPerM },
          })),
        });
      }

      // Auth: OpenAI-style bearer or Anthropic-style x-api-key.
      const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
      const rawKey = req.headers.get("x-api-key") ?? bearer ?? "";
      const key = lookupKey(db, rawKey);

      if (path === "/v1/key" && req.method === "GET") {
        if (!key) return authError();
        return Response.json({
          name: key.name,
          balance_usd: key.balance_nano / 1e9,
        });
      }

      if (path === "/v1/usage" && req.method === "GET") {
        if (!key) return authError();
        return Response.json(usageForKey(db, key.id));
      }

      // ---- seller / marketplace ----
      if (path === "/seller/listings" && req.method === "GET") {
        if (!key) return authError();
        return Response.json({
          listings: listingsForSeller(db, key.id),
          summary: sellerSummary(db, key.id),
          connected: listingsForSeller(db, key.id)
            .filter((l) => registry.has(l.id))
            .map((l) => l.id),
        });
      }
      if (path === "/seller/listings" && req.method === "POST") {
        if (!key) return authError();
        const b: any = await req.json().catch(() => null);
        const listing: NewListing = {
          poolModel: String(b?.poolModel ?? "").trim(),
          upstreamModel: String(b?.upstreamModel ?? "").trim(),
          askInPerM: Number(b?.askInPerM),
          askOutPerM: Number(b?.askOutPerM),
          tokenCap: Math.floor(Number(b?.tokenCap)),
          windowEnd: b?.windowEnd ? String(b.windowEnd) : null,
        };
        if (
          !listing.poolModel ||
          !listing.upstreamModel ||
          !(listing.askInPerM >= 0) ||
          !(listing.askOutPerM >= 0) ||
          !(listing.tokenCap > 0)
        ) {
          return Response.json(
            { error: { type: "invalid_request", message: "Missing or invalid listing fields." } },
            { status: 400 },
          );
        }
        const { id, regToken } = createWorkerListing(db, key.id, listing);
        return Response.json({
          id,
          regToken,
          note: "Registration token shown once. Pass it to your worker via OVERFLOW_REG_TOKEN.",
        });
      }
      const revokeMatch = path.match(/^\/seller\/listings\/(\d+)\/revoke$/);
      if (revokeMatch && req.method === "POST") {
        if (!key) return authError();
        const id = Number(revokeMatch[1]);
        const w = workerById(db, id);
        if (!w || w.seller_key_id !== key.id) {
          return Response.json({ error: { type: "not_found" } }, { status: 404 });
        }
        registry.revoke(id);
        return Response.json({ revoked: true });
      }
      if (path === "/seller/payouts/onboard" && req.method === "POST") {
        if (!key) return authError();
        const acct = await createConnectAccount(db, key);
        if ("error" in acct) {
          return Response.json({ error: { type: "payout_error", message: acct.error } }, {
            status: 400,
          });
        }
        const link = await createAccountLink(acct.accountId, process.env.PUBLIC_BASE_URL ?? url.origin);
        if ("error" in link) {
          return Response.json({ error: { type: "payout_error", message: link.error } }, {
            status: 400,
          });
        }
        return Response.json({ url: link.url });
      }
      if (path === "/seller/payouts/request" && req.method === "POST") {
        if (!key) return authError();
        const result = requestPayout(db, key.id);
        if ("error" in result) {
          return Response.json({ error: { type: "payout_error", message: result.error } }, {
            status: 400,
          });
        }
        return Response.json(result);
      }

      if (req.method === "POST" && path === "/v1/chat/completions") {
        if (!key) return authError();
        const body: any = await req.json().catch(() => null);
        if (!body) {
          return Response.json(
            { error: { type: "invalid_request_error", message: "Body must be JSON." } },
            { status: 400 },
          );
        }
        // Marketplace-first: a live seller worker for this model beats wholesale.
        if (key.balance_nano > 0) {
          const worker = registry.pick(String(body.model ?? ""), Date.now());
          if (worker) {
            return serveFromWorker(
              db,
              registry,
              key,
              worker,
              String(body.model ?? ""),
              body,
              body.stream === true,
            );
          }
        }
        return handleCompletion(body, req.headers, "openai", "/v1/chat/completions", db, config, key);
      }
      if (req.method === "POST" && path === "/v1/messages") {
        if (!key) return authError();
        const body: any = await req.json().catch(() => null);
        if (!body) {
          return Response.json(
            { error: { type: "invalid_request_error", message: "Body must be JSON." } },
            { status: 400 },
          );
        }
        return handleCompletion(body, req.headers, "anthropic", "/v1/messages", db, config, key);
      }

      // Claude Code calls this; pass through un-metered when the upstream supports it.
      if (req.method === "POST" && path === "/v1/messages/count_tokens") {
        if (!key) return authError();
        const body = await req.json().catch(() => null);
        const route = body?.model ? findRoute(config, String(body.model), "anthropic") : undefined;
        if (!route) return Response.json({ error: { type: "model_not_found" } }, { status: 404 });
        const upstream = upstreamFor(config, route.upstream);
        const upstreamKey = process.env[upstream.apiKeyEnv] ?? "";
        try {
          const res = await fetch(
            upstream.anthropicBase!.replace(/\/$/, "") + "/messages/count_tokens",
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-api-key": upstreamKey,
                "anthropic-version": req.headers.get("anthropic-version") ?? "2023-06-01",
              },
              body: JSON.stringify({ ...body, model: route.upstreamModel }),
            },
          );
          return new Response(await res.text(), {
            status: res.status,
            headers: { "content-type": "application/json" },
          });
        } catch {
          return Response.json({ error: { type: "upstream_error" } }, { status: 502 });
        }
      }

      return Response.json({ error: { type: "not_found", message: `no route: ${path}` } }, {
        status: 404,
      });
    },
  });

  // Liveness heartbeat. Unref'd so it never keeps the process (or test runner)
  // alive on its own.
  const heartbeat = setInterval(() => registry.pingAll(), 30_000);
  (heartbeat as unknown as { unref?: () => void }).unref?.();

  console.log(`overflow gateway listening on http://localhost:${server.port}`);
  return { server, db, registry, heartbeat };
}

function authError(): Response {
  return Response.json(
    {
      error: {
        type: "authentication_error",
        message: "Missing or invalid Overflow API key (ovf_...).",
      },
    },
    { status: 401 },
  );
}

if (import.meta.main) startGateway();
