import { defineTool } from "eve/tools";
import { z } from "zod";

// Replaces eve's built-in web_search, which isn't offered when the turn runs on
// local Qwen (a direct OpenAI-compatible model) or a dynamically selected model.
// This works on every backend: a tiny Gateway model is forced to make exactly one
// call to AI Gateway's Exa search tool, and we return compact excerpts.
// Cost per search ≈ $0.007 (Exa) + ~$0.0001 (router tokens).
const ROUTER_MODEL = process.env.SEARCH_ROUTER_MODEL ?? "anthropic/claude-haiku-5.5";

type ExaResult = { title?: string; url?: string; publishedDate?: string | null; highlights?: string[]; text?: string };

export default defineTool({
  description: [
    "Search the web for current facts, news, prices, scores, definitions, or sources (≈$0.007 per search).",
    "Use it to check claims before ruling on an argument, and cite the source (site name + link) in your answer.",
    "Write a specific query. If results are weak or one-sided, search again with different wording (2–3 searches max).",
    "Use web_fetch to read a specific page in full when an excerpt isn't enough.",
  ].join(" "),
  inputSchema: z.object({
    query: z.string().min(2).describe("The search query."),
    numResults: z.number().int().min(1).max(8).optional().describe("Results to return (default 5)."),
    recentDays: z
      .number()
      .int()
      .min(1)
      .max(3650)
      .optional()
      .describe("Only results published in the last N days (news or fast-changing facts)."),
  }),
  async execute({ query, numResults = 5, recentDays }) {
    const { gateway, generateText, isStepCount } = await import("ai");
    const startPublishedDate = recentDays ? new Date(Date.now() - recentDays * 86_400_000).toISOString() : undefined;

    const result = await generateText({
      model: gateway(ROUTER_MODEL),
      prompt: `Call exa_search once with exactly this query: ${query}`,
      tools: {
        exa_search: gateway.tools.exaSearch({
          numResults,
          contents: { highlights: { maxCharacters: 700 } },
          ...(startPublishedDate ? { startPublishedDate } : {}),
        }),
      },
      toolChoice: { type: "tool", toolName: "exa_search" },
      stopWhen: isStepCount(1),
    });

    const output = result.toolResults[0]?.output as
      | { results?: ExaResult[]; error?: string; message?: string }
      | undefined;
    if (!output) return `No search results for "${query}".`;
    if (output.error) return `Search failed (${output.error}): ${output.message ?? ""}`;
    const results = (output.results ?? []).slice(0, numResults);
    if (!results.length) return `No search results for "${query}".`;

    return results
      .map((r, i) => {
        const date = r.publishedDate ? ` (${r.publishedDate.slice(0, 10)})` : "";
        const excerpt = (r.highlights?.join(" … ") || r.text || "").replace(/\s+/g, " ").slice(0, 700);
        return `${i + 1}. ${r.title ?? "Untitled"}${date}\n${r.url}\n${excerpt}`;
      })
      .join("\n\n");
  },
});
