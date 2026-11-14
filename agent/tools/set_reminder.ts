import { defineTool } from "eve/tools";
import { z } from "zod";

import { addReminder, formatLocal, nowLocal, parseLocal, TZ } from "../lib/reminders";

export default defineTool({
  description: [
    "Schedule a reminder that you'll post to this group chat at a given time (optionally repeating).",
    `Give the time either as \`inMinutes\`, or as \`at\` = local wall-clock time "YYYY-MM-DDTHH:mm" in ${TZ}.`,
    "Message timestamps tell you the current date and time. Confirm the exact time back to the group.",
  ].join(" "),
  inputSchema: z.object({
    text: z.string().min(1).max(500).describe("What to remind the group about, written as the reminder message."),
    at: z.string().optional().describe(`Local time in ${TZ}, "YYYY-MM-DDTHH:mm" (e.g. "2026-11-20T19:00").`),
    inMinutes: z.number().int().min(1).max(60 * 24 * 366).optional().describe("Alternative to `at`: minutes from now."),
    repeat: z.enum(["none", "daily", "weekdays", "weekly"]).optional().describe("Repeat schedule (default none)."),
  }),
  async execute({ text, at, inMinutes, repeat = "none" }, ctx) {
    const spaceId = ctx.conversation?.space?.id ?? "";
    const conversationId = spaceId.startsWith("gmessages:") ? spaceId.slice("gmessages:".length) : "";
    if (!conversationId) return "Reminders only work inside the group chat.";

    const dueAt = inMinutes ? Date.now() + inMinutes * 60_000 : at ? parseLocal(at) : null;
    if (!dueAt) return `Couldn't understand the time. It's now ${nowLocal()}. Use at="YYYY-MM-DDTHH:mm" or inMinutes.`;
    if (dueAt < Date.now() - 60_000) return `That time is in the past. It's now ${nowLocal()}.`;
    if (dueAt > Date.now() + 366 * 86_400_000) return "Reminders can be at most a year out.";

    const by = String(ctx.session.auth.current?.attributes?.name ?? "") || "someone";
    const r = await addReminder({ conversationId, text, by, dueAt, repeat });
    return `Reminder ${r.id} set for ${formatLocal(r.dueAt)}${repeat !== "none" ? `, repeating ${repeat}` : ""}.`;
  },
});
