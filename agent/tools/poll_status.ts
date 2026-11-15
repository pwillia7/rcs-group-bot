import { defineTool } from "eve/tools";
import { z } from "zod";

import { findPoll, openPolls, recentPolls, renderStatus } from "../lib/polls";

export default defineTool({
  description:
    "Show poll results: the question, each option's letter and vote count, and who has voted. Omit id to show all open polls (most recent last). Set recent: true to also include closed polls (the last 5), e.g. to find the exact question and options before redoing a poll.",
  inputSchema: z.object({ id: z.string().optional(), recent: z.boolean().optional() }),
  async execute({ id, recent }, ctx) {
    const spaceId = ctx.conversation?.space?.id ?? "";
    const conv = spaceId.startsWith("gmessages:") ? spaceId.slice("gmessages:".length) : "";
    if (!conv) return "Polls only work inside the group chat.";
    if (id) {
      const p = await findPoll(conv, id);
      return p ? renderStatus(p) : `No poll with id ${id}.`;
    }
    const polls = recent ? await recentPolls(conv) : await openPolls(conv);
    return polls.length ? polls.map(renderStatus).join("\n\n") : recent ? "no polls yet" : "no open poll";
  },
});
