// Upstreams and the model routing table.
//
// The gateway is shape-preserving: an OpenAI-shaped request is only ever routed
// to an upstream with an `openaiBase`, an Anthropic-shaped request only to one
// with an `anthropicBase`. No cross-shape translation happens anywhere.
//
// Prices are what WE charge, in USD per million tokens. Convention throughout
// the codebase: $/M tokens is numerically equal to microdollars per token, and
// balances are stored in nanodollars (1e-9 USD) so all arithmetic is integer.

export type Shape = "openai" | "anthropic";

export interface Upstream {
  name: string;
  /** Base including the provider's version prefix; /chat/completions is appended */
  openaiBase?: string;
  /** Base including the provider's version prefix; /messages is appended */
  anthropicBase?: string;
  apiKeyEnv: string;
}

export interface ModelRoute {
  /** Public pool model id, shown in /v1/models and stamped on responses */
  pool: string;
  upstream: string;
  upstreamModel: string;
  /** USD per million input tokens (what we charge) */
  inPerM: number;
  /** USD per million output tokens (what we charge) */
  outPerM: number;
  /** Requested-model patterns this route serves as a fallback for */
  match: RegExp[];
}

export interface GatewayConfig {
  upstreams: Upstream[];
  routes: ModelRoute[];
}

export const defaultConfig: GatewayConfig = {
  upstreams: [
    {
      name: "zai",
      openaiBase: "https://api.z.ai/api/paas/v4",
      anthropicBase: "https://api.z.ai/api/anthropic/v1",
      apiKeyEnv: "ZAI_API_KEY",
    },
    {
      name: "deepseek",
      openaiBase: "https://api.deepseek.com/v1",
      anthropicBase: "https://api.deepseek.com/anthropic/v1",
      apiKeyEnv: "DEEPSEEK_API_KEY",
    },
    {
      name: "deepinfra",
      openaiBase: "https://api.deepinfra.com/v1/openai",
      apiKeyEnv: "DEEPINFRA_API_KEY",
    },
  ],
  routes: [
    // Anthropic-shaped claude-* traffic lands here first (zai speaks /v1/messages).
    {
      pool: "glm-4.6",
      upstream: "zai",
      upstreamModel: "glm-4.6",
      inPerM: 0.72,
      outPerM: 2.64,
      match: [/^glm/i, /^claude/i],
    },
    {
      pool: "deepseek-chat",
      upstream: "deepseek",
      upstreamModel: "deepseek-chat",
      inPerM: 0.34,
      outPerM: 0.5,
      match: [/^deepseek/i, /^gpt/i, /^o[134]/i, /^claude/i],
    },
    {
      pool: "qwen3-coder",
      upstream: "deepinfra",
      upstreamModel: "Qwen/Qwen3-Coder-480B-A35B-Instruct",
      inPerM: 0.48,
      outPerM: 1.92,
      match: [/^qwen/i, /^claude/i, /^gpt/i],
    },
  ],
};

export function upstreamFor(config: GatewayConfig, name: string): Upstream {
  const u = config.upstreams.find((u) => u.name === name);
  if (!u) throw new Error(`unknown upstream: ${name}`);
  return u;
}

function usableUpstream(u: Upstream, shape: Shape): boolean {
  const speaksShape = shape === "openai" ? !!u.openaiBase : !!u.anthropicBase;
  return speaksShape && !!process.env[u.apiKeyEnv];
}

/**
 * Pick the route for a requested model + wire shape. Exact pool-name matches
 * win; otherwise the first fallback route (in config order) whose pattern
 * matches and whose upstream both speaks the request's shape and has an API
 * key configured — so the gateway runs fine with a single provider key.
 */
export function findRoute(
  config: GatewayConfig,
  requestedModel: string,
  shape: Shape,
): ModelRoute | undefined {
  const usable = config.routes.filter((r) =>
    usableUpstream(upstreamFor(config, r.upstream), shape),
  );
  return (
    usable.find((r) => r.pool === requestedModel) ??
    usable.find((r) => r.match.some((m) => m.test(requestedModel)))
  );
}

/** Cost in nanodollars. inPerM/outPerM ($/M) === microdollars per token. */
export function costNano(route: ModelRoute, inTokens: number, outTokens: number): number {
  return Math.round(inTokens * route.inPerM * 1000 + outTokens * route.outPerM * 1000);
}
