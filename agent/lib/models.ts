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

/**
 * How long Qwen gets to produce its first token (text, reasoning or a tool call)
 * before the call is cancelled and rerun on Claude. Normal cold path: model
 * reload after idle sleep 30-50 s + prefill at ~900 tok/s, so ~100 s worst case
 * on a long uncached prompt. A shared GPU (ComfyUI generating) drops prefill to
 * ~50 tok/s and a 17k prompt then takes ~6 min, which this catches.
 */
const QWEN_FIRST_TOKEN_TIMEOUT_MS = Number(process.env.QWEN_FIRST_TOKEN_TIMEOUT_MS ?? 150_000);
/** After a missed deadline, skip Qwen this long so later calls don't wait again. */
const QWEN_SLOW_TTL_S = Number(process.env.QWEN_SLOW_TTL_S ?? 600);

export async function qwenSlow(): Promise<boolean> {
  try {
    return (await redis().get(keys.qwenSlow)) != null;
  } catch {
    return false;
  }
}

async function markQwenSlow(): Promise<void> {
  try {
    await redis().set(keys.qwenSlow, Date.now(), { ex: QWEN_SLOW_TTL_S });
  } catch {
    // best effort: without the flag the next call just waits for the deadline again
  }
}

/** Decide the backend for one turn. */
export async function pickBackend(): Promise<Backend> {
  const mode = await getModelMode();
  if (mode === "claude") return "claude";
  if (mode === "qwen") return "qwen";
  if (await qwenSlow()) return "claude";
  return (await qwenHealthy()) ? "qwen" : "claude";
}

/** Stream parts that mean the model is actually producing output. */
const PROGRESS_PARTS = new Set([
  "text-start",
  "text-delta",
  "reasoning-start",
  "reasoning-delta",
  "tool-input-start",
  "tool-input-delta",
  "tool-call",
  "finish",
  "error",
]);

export class QwenFirstTokenTimeout extends Error {
  constructor() {
    super(`qwen produced no output within ${QWEN_FIRST_TOKEN_TIMEOUT_MS} ms`);
  }
}

/**
 * Start a Qwen stream and wait for its first real output part. Resolves with a
 * stream that replays what was buffered and then continues; rejects (and aborts
 * the request, which frees the llama-server slot) if the deadline passes first.
 */
export async function qwenStreamWithDeadline(
  model: Parameters<NonNullable<LanguageModelMiddleware["wrapStream"]>>[0]["model"],
  params: Parameters<NonNullable<LanguageModelMiddleware["wrapStream"]>>[0]["params"],
) {
  const deadline = new AbortController();
  const signal = params.abortSignal ? AbortSignal.any([params.abortSignal, deadline.signal]) : deadline.signal;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    deadline.abort(new QwenFirstTokenTimeout());
  }, QWEN_FIRST_TOKEN_TIMEOUT_MS);
  // The caller cancelling isn't Qwen being slow.
  params.abortSignal?.addEventListener("abort", () => clearTimeout(timer), { once: true });

  try {
    const result = await model.doStream({ ...params, abortSignal: signal });
    const reader = result.stream.getReader();
    const buffered: Awaited<ReturnType<typeof reader.read>>["value"][] = [];
    let done = false;
    // llama-server may send headers before prefill finishes, so the deadline
    // covers reading too; aborting the signal errors the pending read.
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        done = true;
        break;
      }
      buffered.push(next.value);
      if (PROGRESS_PARTS.has(next.value.type)) break;
    }
    clearTimeout(timer);
    const stream = new ReadableStream({
      start(controller) {
        for (const part of buffered) controller.enqueue(part);
        if (done) controller.close();
      },
      async pull(controller) {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    return { ...result, stream };
  } catch (error) {
    clearTimeout(timer);
    if (timedOut) {
      deadline.abort();
      throw new QwenFirstTokenTimeout();
    }
    throw error;
  }
}

/**
 * Qwen -> Claude fallback.
 * - Qwen fails before answering (PC asleep, Funnel hiccup): rerun the call on Claude.
 * - Qwen sends nothing for QWEN_FIRST_TOKEN_TIMEOUT_MS (GPU shared with ComfyUI,
 *   stuck prefill): cancel it, rerun on Claude, and flag Qwen slow so the rest of
 *   the turn and the next turns skip it for QWEN_SLOW_TTL_S.
 * A caller cancelling the call (params.abortSignal) is passed through, not retried.
 */
const fallbackToGateway: LanguageModelMiddleware = {
  specificationVersion: "v4",
  wrapGenerate: async ({ doGenerate, params }) => {
    if (await qwenSlow()) return gateway(FALLBACK_MODEL).doGenerate(params);
    try {
      return await doGenerate();
    } catch (error) {
      if (params.abortSignal?.aborted) throw error;
      console.warn("[models] qwen generate failed; falling back to gateway", error);
      return gateway(FALLBACK_MODEL).doGenerate(params);
    }
  },
  wrapStream: async ({ model, params }) => {
    if (await qwenSlow()) return gateway(FALLBACK_MODEL).doStream(params);
    try {
      return await qwenStreamWithDeadline(model, params);
    } catch (error) {
      if (params.abortSignal?.aborted) throw error;
      if (error instanceof QwenFirstTokenTimeout) {
        console.warn(`[models] ${error.message}; falling back to gateway for ${QWEN_SLOW_TTL_S}s`);
        await markQwenSlow();
      } else {
        console.warn("[models] qwen stream failed; falling back to gateway", error);
      }
      return gateway(FALLBACK_MODEL).doStream(params);
    }
  },
};

export function qwenModel() {
  return wrapLanguageModel({ model: qwenProvider(QWEN_MODEL), middleware: fallbackToGateway });
}
