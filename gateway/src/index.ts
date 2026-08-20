import { openDb, lookupKey } from "./db";
import { defaultConfig, findRoute, upstreamFor, type GatewayConfig } from "./config";
import { handleCompletion } from "./proxy";

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
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/healthz") return Response.json({ ok: true });

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
