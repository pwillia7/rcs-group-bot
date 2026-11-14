import { defineTool } from "eve/tools";
import { z } from "zod";

import { formatLocal, listReminders, nowLocal } from "../lib/reminders";

export default defineTool({
  description: "List this group's upcoming reminders (id, time, repeat, who set it).",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const spaceId = ctx.conversation?.space?.id ?? "";
    const conversationId = spaceId.startsWith("gmessages:") ? spaceId.slice("gmessages:".length) : "";
    const reminders = await listReminders(conversationId);
    if (!reminders.length) return `No upcoming reminders. (Now: ${nowLocal()})`;
    return reminders
      .map((r) => `${r.id}: ${formatLocal(r.dueAt)}${r.repeat !== "none" ? ` (${r.repeat})` : ""}, by ${r.by}: ${r.text}`)
      .join("\n");
  },
});
