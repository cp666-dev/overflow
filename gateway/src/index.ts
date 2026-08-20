import { openDb, lookupKey, createApiKey, emailExists, usageForKey } from "./db";
import { defaultConfig, findRoute, upstreamFor, type GatewayConfig } from "./config";
import { handleCompletion } from "./proxy";
import { applyWebhookEvent, createCheckoutSession, verifyStripeSignature, PACKS } from "./billing";

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

  const server = Bun.serve({
    port: opts.port ?? Number(process.env.OVERFLOW_PORT ?? 8484),
    idleTimeout: 240,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/healthz") return Response.json({ ok: true });

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

      if (req.method === "POST" && path === "/v1/chat/completions") {
        if (!key) return authError();
        return handleCompletion(req, "openai", "/v1/chat/completions", db, config, key);
      }
      if (req.method === "POST" && path === "/v1/messages") {
        if (!key) return authError();
        return handleCompletion(req, "anthropic", "/v1/messages", db, config, key);
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

  console.log(`overflow gateway listening on http://localhost:${server.port}`);
  return { server, db };
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
