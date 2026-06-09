// Shared Anthropic client for the CFO Agent.
//
// ANTHROPIC_API_KEY is required — set it in .env locally and on Vercel.
// The key is server-only and must never reach the browser bundle (this
// module is only imported from server-side route handlers).
//
// Model + max-tokens are env-configurable so you can swap models or tune
// cost without touching code.

import Anthropic from "@anthropic-ai/sdk";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 4096;

let cached: Anthropic | null = null;

export function anthropicClient(): Anthropic {
  if (cached) return cached;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not configured. Add it to .env (local) and " +
        "Vercel project environment variables (production).",
    );
  }
  cached = new Anthropic({ apiKey });
  return cached;
}

export function anthropicModel(): string {
  return process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
}

export function anthropicMaxTokens(): number {
  const v = process.env.ANTHROPIC_MAX_TOKENS;
  if (!v) return DEFAULT_MAX_TOKENS;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_TOKENS;
}
