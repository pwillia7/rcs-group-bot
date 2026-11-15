import { defineTool } from "eve/tools";
import { z } from "zod";

import { closePoll, findPoll, renderFinal } from "../lib/polls";

export default defineTool({
  description: "Close a poll by id and report the final tallies and the winner.",
  inputSchema: z.object({ id: z.string().min(1) }),
  async execute({ id }, ctx) {
    const spaceId = ctx.conversation?.space?.id ?? "";
    const conv = spaceId.startsWith("gmessages:") ? spaceId.slice("gmessages:".length) : "";
    if (!conv) return "Polls only work inside the group chat.";
    const p = await findPoll(conv, id);
    if (!p) return `No poll with id ${id}.`;
    if (p.closed) return `Poll ${p.id} was already closed.\n${renderFinal(p)}`;
    return renderFinal(await closePoll(conv, p));
  },
});
