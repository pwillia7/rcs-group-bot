import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { gateway, wrapLanguageModel, type LanguageModelMiddleware } from "ai";

import { keys, redis } from "./redis";

export type Backend = "qwen" | "claude";
export type ModelMode = "auto" | Backend;

const QWEN_BASE_URL = (process.env.QWEN_BASE_URL ?? "").replace(/\/+$/, "");
const QWEN_MODEL = process.env.QWEN_MODEL ?? "qwen3.8-27b";

/** Human-readable model for a backend, e.g. for /status. */
export function modelLabel(backend: Backend): string {
  return backend === "qwen" ? `${QWEN_MODEL} (local, home PC)` : `${FALLBACK_MODEL} (AI Gateway)`;
}
export const FALLBACK_MODEL = process.env.FALLBACK_MODEL ?? "anthropic/claude-sonnet-5.5";
// llama-server: -c 204800 --parallel 2 → ~102k per slot. Use the same window for
// both backends so a mid-session switch never overflows Qwen.
export const CONTEXT_WINDOW = Number(process.env.MODEL_CONTEXT_WINDOW ?? 100_000);

const qwenProvider = createOpenAICompatible({
  name: "qwen",
  baseURL: `${QWEN_BASE_URL}/v1`,
  apiKey: process.env.QWEN_API_KEY,
  includeUsage: true,
});

/** Qwen health: llama-server's /health needs no API key. */
export async function qwenHealthy(timeoutMs = 1500): Promise<boolean> {
  if (!QWEN_BASE_URL) return false;
  try {
    const res = await fetch(`${QWEN_BASE_URL}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function getModelMode(): Promise<ModelMode> {
  try {
    const mode = await redis().get<string>(keys.modelMode);
    if (mode === "qwen" || mode === "claude" || mode === "auto") return mode;
  } catch {
    // Redis down: fall through to the env default
  }
  const env = process.env.MODEL_MODE;
  return env === "qwen" || env === "claude" ? env : "auto";
}

export async function setModelMode(mode: ModelMode): Promise<void> {
  await redis().set(keys.modelMode, mode);
}

/** Decide the backend for one turn. */
export async function pickBackend(): Promise<Backend> {
  const mode = await getModelMode();
  if (mode === "claude") return "claude";
  if (mode === "qwen") return "qwen";
  return (await qwenHealthy()) ? "qwen" : "claude";
}

/**
 * If Qwen fails before it starts answering (PC went to sleep mid-turn, Funnel
 * hiccup), retry the same call on Claude via AI Gateway instead of failing the turn.
 */
const fallbackToGateway: LanguageModelMiddleware = {
  specificationVersion: "v4",
  wrapGenerate: async ({ doGenerate, params }) => {
    try {
      return await doGenerate();
    } catch (error) {
      console.warn("[models] qwen generate failed; falling back to gateway", error);
      return gateway(FALLBACK_MODEL).doGenerate(params);
    }
  },
  wrapStream: async ({ doStream, params }) => {
    try {
      return await doStream();
    } catch (error) {
      console.warn("[models] qwen stream failed; falling back to gateway", error);
      return gateway(FALLBACK_MODEL).doStream(params);
    }
  },
};

export function qwenModel() {
  return wrapLanguageModel({ model: qwenProvider(QWEN_MODEL), middleware: fallbackToGateway });
}
