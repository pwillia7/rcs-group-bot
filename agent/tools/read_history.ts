import { randomUUID } from "node:crypto";

import { defineTool } from "eve/tools";
import { z } from "zod";

import { keys, pushOutbox, redis } from "../lib/redis";

type HistoryResult = {
  messages: { ts: number; sender: string; text: string }[];
  nextCursor?: string;
  scanned: number;
  error?: string;
};

const TZ = process.env.BOT_TIMEZONE ?? "America/New_York";
const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export default defineTool({
  description: [
    "Read older messages from this group chat, straight from the phone. Use it only when someone asks about",
    "something said earlier that isn't already in your context (e.g. 'what did Sam say about Friday?', 'summarize",
    "this week'). It reads the full history, including messages sent before you were added.",
    "Cost guidance: use `search` for a specific topic or person — it scans up to ~600 messages but returns only",
    "matches. Without search, start with a small `count` (20–40) and page further back with `before` only if needed.",
  ].join(" "),
  inputSchema: z.object({
    search: z
      .string()
      .min(2)
      .optional()
      .describe("Case-insensitive keyword or name to filter by. Matches text or sender."),
    count: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("How many messages to return (default 30, max 100). With search: max matches to return."),
    before: z
      .string()
      .optional()
      .describe("Cursor from a previous call's `older` field, to page further back."),
  }),
  async execute({ search, count, before }, ctx) {
    const spaceId = ctx.conversation?.space?.id ?? "";
    const conversationId = spaceId.startsWith("gmessages:") ? spaceId.slice("gmessages:".length) : "";
    if (!conversationId) return "History is only available inside a group chat conversation.";

    const replyKey = `rpc:${randomUUID()}`;
    await pushOutbox({
      id: replyKey,
      kind: "history",
      conversationId,
      count: count ?? (search ? 20 : 30),
      search,
      cursor: before,
      replyKey,
    });

    // The connector answers through Redis; it usually takes 1–5 s (one phone round-trip per 50 messages).
    const deadline = Date.now() + 25_000;
    let result: HistoryResult | null = null;
    while (Date.now() < deadline) {
      result = await redis().get<HistoryResult>(keys.rpc(replyKey));
      if (result) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    if (!result) return "The phone didn't answer in time (it may be offline). Try again later.";
    await redis().del(keys.rpc(replyKey));
    if (result.error && result.messages.length === 0) return `Couldn't read history: ${result.error}`;

    // Compact text, not JSON: far fewer tokens for the model.
    const lines = result.messages.map((m) => `[${fmt.format(new Date(m.ts))}] ${m.sender}: ${m.text}`);
    const header = search
      ? `${result.messages.length} message(s) matching "${search}" (scanned ${result.scanned}):`
      : `${result.messages.length} message(s), oldest first:`;
    const footer = result.nextCursor ? `\n(older: "${result.nextCursor}")` : "\n(reached the start of the chat)";
    return lines.length ? `${header}\n${lines.join("\n")}${footer}` : `No messages found (scanned ${result.scanned}).${footer}`;
  },
});
