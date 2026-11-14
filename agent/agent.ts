import { defineAgent } from "eve";
import { defineDynamic } from "eve/models";

import { CONTEXT_WINDOW, FALLBACK_MODEL, pickBackend, qwenModel } from "./lib/models";

export default defineAgent({
  description: "A friendly assistant that lives in an RCS group chat.",
  // Qwen on the home PC (via Tailscale Funnel) when it's up; Claude via AI Gateway otherwise.
  // The choice is memoized per turn so one turn never flips backends between steps
  // (the middleware still falls back if Qwen dies mid-turn).
  model: defineDynamic(async (ctx) => {
    const backend = await ctx.memo(["backend", ctx.turn?.id ?? null], pickBackend);
    if (backend === "qwen") {
      return { model: qwenModel(), reasoning: "low", modelContextWindowTokens: CONTEXT_WINDOW };
    }
    return { model: FALLBACK_MODEL, reasoning: "low", modelContextWindowTokens: CONTEXT_WINDOW };
  }),
});
