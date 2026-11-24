import { defineTool } from "eve/tools";
import { z } from "zod";

import { listBotPrs } from "../../../lib/github";

export default defineTool({
  description: "List the bot's open self-modification PRs (number, title, draft or ready, branch, URL), newest first.",
  inputSchema: z.object({}),
  async execute() {
    const prs = await listBotPrs();
    if (!prs.length) return "No open bot PRs.";
    return prs.map((p) => `#${p.number} ${p.title} (${p.draft ? "draft" : "ready for review"}) ${p.url}`).join("\n");
  },
});
