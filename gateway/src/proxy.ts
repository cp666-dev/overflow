import type { Database } from "bun:sqlite";
import {
  costNano,
  findRoute,
  upstreamFor,
  type GatewayConfig,
  type ModelRoute,
  type Shape,
  type Upstream,
} from "./config";
import { recordUsage, type ApiKey } from "./db";

interface Usage {
  inTokens: number;
  outTokens: number;
}

function jsonError(status: number, type: string, message: string): Response {
  return Response.json({ error: { type, message } }, { status });
}

function upstreamHeaders(shape: Shape, upstream: Upstream, incoming: Headers): Headers {
  const h = new Headers({ "content-type": "application/json" });
  const key = process.env[upstream.apiKeyEnv];
  if (!key) throw new Error(`missing env ${upstream.apiKeyEnv} for upstream ${upstream.name}`);
  if (shape === "anthropic") {
    h.set("x-api-key", key);
    h.set("anthropic-version", incoming.get("anthropic-version") ?? "2023-06-01");
  } else {
    h.set("authorization", `Bearer ${key}`);
  }
  return h;
}

function upstreamUrl(shape: Shape, upstream: Upstream, path: string): string {
  const base = shape === "anthropic" ? upstream.anthropicBase : upstream.openaiBase;
  if (!base) throw new Error(`upstream ${upstream.name} does not speak ${shape}`);
  // Bases carry the provider's own version prefix (e.g. /v1, /api/paas/v4),
  // so strip the standard /v1 from the incoming path before appending.
  return base.replace(/\/$/, "") + path.replace(/^\/v1/, "");
}

/** Pull token usage out of a complete (non-streaming) response body. */
function usageFromBody(shape: Shape, body: any): Usage {
  const u = body?.usage ?? {};
  return shape === "anthropic"
    ? { inTokens: u.input_tokens ?? 0, outTokens: u.output_tokens ?? 0 }
    : { inTokens: u.prompt_tokens ?? 0, outTokens: u.completion_tokens ?? 0 };
}

/**
 * Scans SSE `data:` lines from either wire shape and accumulates token usage.
 * OpenAI: a final chunk carries `usage` (we inject stream_options to get it).
 * Anthropic: `message_start` carries input_tokens, `message_delta` carries a
 * cumulative output_tokens.
 */
export class SseUsageScanner {
  usage: Usage = { inTokens: 0, outTokens: 0 };
  private buf = "";

  constructor(private shape: Shape) {}

  feed(text: string): void {
    this.buf += text;
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? "";
    for (const line of lines) this.line(line);
  }

  flush(): void {
    if (this.buf) this.line(this.buf);
    this.buf = "";
  }

  private line(line: string): void {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let data: any;
    try {
      data = JSON.parse(payload);
    } catch {
      return;
    }
    if (this.shape === "anthropic") {
      if (data.type === "message_start" && data.message?.usage) {
        this.usage.inTokens = data.message.usage.input_tokens ?? this.usage.inTokens;
        this.usage.outTokens = data.message.usage.output_tokens ?? this.usage.outTokens;
      } else if (data.type === "message_delta" && data.usage) {
        if (data.usage.input_tokens != null) this.usage.inTokens = data.usage.input_tokens;
        if (data.usage.output_tokens != null) this.usage.outTokens = data.usage.output_tokens;
      }
    } else if (data.usage) {
      this.usage.inTokens = data.usage.prompt_tokens ?? this.usage.inTokens;
      this.usage.outTokens = data.usage.completion_tokens ?? this.usage.outTokens;
    }
  }
}

function settle(
  db: Database,
  key: ApiKey,
  shape: Shape,
  requestedModel: string,
  route: ModelRoute,
  usage: Usage,
): { costNano: number; balanceNano: number } {
  const cost = costNano(route, usage.inTokens, usage.outTokens);
  const balance = recordUsage(db, {
    keyId: key.id,
    shape,
    requestedModel,
    servedModel: route.pool,
    upstream: route.upstream,
    inTokens: usage.inTokens,
    outTokens: usage.outTokens,
    costNano: cost,
  });
  return { costNano: cost, balanceNano: balance };
}

/**
 * The whole product: authenticate, check balance, route to a same-shaped
 * upstream, forward, meter tokens, debit, and stamp the served model on the
 * response so substitution is never silent.
 */
export async function handleCompletion(
  req: Request,
  shape: Shape,
  path: string,
  db: Database,
  config: GatewayConfig,
  key: ApiKey,
): Promise<Response> {
  if (key.balance_nano <= 0) {
    return jsonError(
      402,
      "insufficient_credits",
      "Your Overflow balance is empty. Top up to keep going.",
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "invalid_request_error", "Body must be JSON.");
  }

  const requestedModel = String(body?.model ?? "");
  const route = findRoute(config, requestedModel, shape);
  if (!route) {
    return jsonError(
      404,
      "model_not_found",
      `No pool route for model "${requestedModel}" over the ${shape} API.`,
    );
  }
  const upstream = upstreamFor(config, route.upstream);

  body.model = route.upstreamModel;
  const streaming = body.stream === true;
  if (streaming && shape === "openai") {
    body.stream_options = { ...(body.stream_options ?? {}), include_usage: true };
  }

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstreamUrl(shape, upstream, path), {
      method: "POST",
      headers: upstreamHeaders(shape, upstream, req.headers),
      body: JSON.stringify(body),
    });
  } catch (e) {
    return jsonError(502, "upstream_error", `Upstream ${upstream.name} unreachable: ${e}`);
  }

  const stamp = (h: Headers) => {
    h.set("x-overflow-served-model", route.pool);
    h.set("x-overflow-upstream", route.upstream);
  };

  if (!upstreamRes.ok) {
    // Pass upstream errors through un-metered, minus upstream auth details.
    const errBody = await upstreamRes.text();
    const h = new Headers({ "content-type": "application/json" });
    stamp(h);
    return new Response(errBody, { status: upstreamRes.status, headers: h });
  }

  if (!streaming) {
    const resBody = await upstreamRes.json();
    const { costNano: cost, balanceNano } = settle(
      db,
      key,
      shape,
      requestedModel,
      route,
      usageFromBody(shape, resBody),
    );
    const h = new Headers({ "content-type": "application/json" });
    stamp(h);
    h.set("x-overflow-cost-nanousd", String(cost));
    h.set("x-overflow-balance-nanousd", String(balanceNano));
    return new Response(JSON.stringify(resBody), { status: 200, headers: h });
  }

  // Streaming: pipe bytes through untouched while scanning for usage, settle on close.
  const scanner = new SseUsageScanner(shape);
  const decoder = new TextDecoder();
  const meter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      scanner.feed(decoder.decode(chunk, { stream: true }));
      controller.enqueue(chunk);
    },
    flush() {
      scanner.flush();
      settle(db, key, shape, requestedModel, route, scanner.usage);
    },
  });

  const h = new Headers();
  const ct = upstreamRes.headers.get("content-type");
  if (ct) h.set("content-type", ct);
  h.set("cache-control", "no-store");
  stamp(h);
  return new Response(upstreamRes.body!.pipeThrough(meter), { status: 200, headers: h });
}
