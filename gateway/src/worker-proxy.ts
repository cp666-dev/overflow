// Serve an OpenAI-shape completion from a connected seller worker. Meters both
// sides atomically (buyer debited at the grossed-up price, seller credited at
// their ask), and flips the listing to `exhausted` when the token cap is hit.

import type { Database } from "bun:sqlite";
import { settleMarketplaceUsage } from "./marketplace";
import type { Connected, WorkerRegistry } from "./workers-registry";
import type { ApiKey } from "./db";

function stampHeaders(poolModel: string, workerId: number, extra?: Record<string, string>): Headers {
  const h = new Headers({ "content-type": "application/json" });
  h.set("x-overflow-served-model", poolModel);
  h.set("x-overflow-upstream", `worker:${workerId}`);
  h.set("x-overflow-marketplace", "1");
  for (const [k, v] of Object.entries(extra ?? {})) h.set(k, v);
  return h;
}

/**
 * Dispatch to `worker` and return a client Response. The worker always streams
 * internally; for a non-streaming client we assemble one completion object, for
 * a streaming client we forward OpenAI SSE frames.
 */
export async function serveFromWorker(
  db: Database,
  registry: WorkerRegistry,
  key: ApiKey,
  worker: Connected,
  requestedModel: string,
  body: any,
  clientStreaming: boolean,
): Promise<Response> {
  const listing = worker.listing;
  const upstreamBody = {
    ...body,
    model: listing.upstream_model,
    stream: true,
    stream_options: { include_usage: true },
  };
  const handle = registry.dispatch(worker, upstreamBody, "infer");

  const settle = (u: { prompt_tokens: number; completion_tokens: number }) =>
    settleMarketplaceUsage(db, {
      buyerKeyId: key.id,
      worker: listing,
      requestedModel,
      inTokens: u.prompt_tokens,
      outTokens: u.completion_tokens,
    });

  if (!clientStreaming) {
    const reader = handle.chunks.getReader();
    let content = "";
    let servedModel = listing.upstream_model;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.model) servedModel = value.model;
        content += value?.choices?.[0]?.delta?.content ?? "";
      }
    } catch (e) {
      return Response.json(
        { error: { type: "worker_error", message: String(e) } },
        { status: 502, headers: stampHeaders(listing.pool_model, listing.id) },
      );
    }
    const u = await handle.usage;
    const s = settle(u);
    const completion = {
      id: `ovf-${listing.id}-${Date.now()}`,
      object: "chat.completion",
      model: servedModel,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: u.prompt_tokens,
        completion_tokens: u.completion_tokens,
        total_tokens: u.prompt_tokens + u.completion_tokens,
      },
    };
    return new Response(JSON.stringify(completion), {
      headers: stampHeaders(listing.pool_model, listing.id, {
        "x-overflow-cost-nanousd": String(s.buyerCostNano),
        "x-overflow-balance-nanousd": String(s.buyerBalanceNano),
      }),
    });
  }

  // Streaming client: forward each chunk as an OpenAI SSE frame.
  const enc = new TextEncoder();
  const out = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = handle.chunks.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(enc.encode(`data: ${JSON.stringify(value)}\n\n`));
        }
        const u = await handle.usage;
        settle(u);
        controller.enqueue(
          enc.encode(
            `data: ${JSON.stringify({
              object: "chat.completion.chunk",
              choices: [],
              usage: {
                prompt_tokens: u.prompt_tokens,
                completion_tokens: u.completion_tokens,
                total_tokens: u.prompt_tokens + u.completion_tokens,
              },
            })}\n\n`,
          ),
        );
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (e) {
        controller.enqueue(
          enc.encode(`data: ${JSON.stringify({ error: { message: String(e) } })}\n\n`),
        );
        controller.close();
      }
    },
  });

  const h = stampHeaders(listing.pool_model, listing.id);
  h.set("content-type", "text/event-stream");
  h.set("cache-control", "no-store");
  return new Response(out, { headers: h });
}
