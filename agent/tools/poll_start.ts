import { defineTool } from "eve/tools";
import { z } from "zod";

import { renderOpened, startPoll } from "../lib/polls";

export default defineTool({
  description:
    "Start a live poll in this group. Provide the question and 2-26 options (lettered A, B, C... in order). Then tell the group to vote by sending a letter, add an option with 'add <text>', see results with 'poll status', and close with 'close poll'. Votes are one per person and can be changed.",
  inputSchema: z.object({ question: z.string().min(1), options: z.array(z.string().min(1)).min(2).max(26) }),
  async execute({ question, options }, ctx) {
    const spaceId = ctx.conversation?.space?.id ?? "";
    const conv = spaceId.startsWith("gmessages:") ? spaceId.slice("gmessages:".length) : "";
    if (!conv) return "Polls only work inside the group chat.";
    const poll = await startPoll(conv, question, options);
    return `${poll.id}: ${renderOpened(poll)}`;
  },
});
