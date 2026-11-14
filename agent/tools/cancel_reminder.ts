import { defineTool } from "eve/tools";
import { z } from "zod";

import { cancelReminder, formatLocal } from "../lib/reminders";

export default defineTool({
  description: "Cancel one of this group's reminders by id (use list_reminders to find it).",
  inputSchema: z.object({ id: z.string().min(1) }),
  async execute({ id }, ctx) {
    const spaceId = ctx.conversation?.space?.id ?? "";
    const conversationId = spaceId.startsWith("gmessages:") ? spaceId.slice("gmessages:".length) : "";
    const r = await cancelReminder(conversationId, id);
    return r ? `Cancelled reminder ${r.id} (${formatLocal(r.dueAt)}): ${r.text}` : `No reminder with id ${id}.`;
  },
});
