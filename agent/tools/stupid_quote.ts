import { defineTool } from "eve/tools";
import { z } from "zod";

import { fetchHistory, type HistoryMessage } from "../lib/history";

const TZ = process.env.BOT_TIMEZONE ?? "America/New_York";
const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

/** Calendar-day number (in TZ) for a timestamp. */
function dayNumber(ts: number): number {
  const [y, m, d] = dayFmt.format(new Date(ts)).split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}
const dateFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const PAGE = 100;
const MAX_HOPS = 4; // random number of pages to skip back before sampling
const MAX_CANDIDATES = 40;

function isQuotable(m: HistoryMessage): boolean {
  const t = m.text?.trim() ?? "";
  if (t.length < 12 || t.length > 280) return false;
  if (t.startsWith("🤖") || t.startsWith("/")) return false; // bot output and commands
  if (/https?:\/\//i.test(t)) return false;
  if (/\b(bot|claude|qwen)\b/i.test(t)) return false; // messages addressed to the bot
  return true;
}

function relativeAge(ts: number): string {
  const days = dayNumber(Date.now()) - dayNumber(ts);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} day(s) ago`;
  if (days < 60) return `about ${Math.round(days / 7)} weeks ago`;
  if (days < 700) return `about ${Math.round(days / 30)} months ago`;
  return `about ${(days / 365).toFixed(1)} years ago`;
}

export default defineTool({
  description: [
    "Dig up candidate 'stupid' (funny/dumb) quotes from older messages in this group chat. Use it whenever someone asks",
    "for a stupid, dumb, or funny quote from the chat, and for the daily quote post. It samples a random stretch of",
    "older history and returns a handful of candidate messages with who said them and when. You then pick the single",
    "funniest/dumbest one and share it as: the quote, who said it, and roughly when (e.g. 'about 3 months ago, Mar 4').",
    "Senders are shown by their contact names; credit them by the names and nicknames in your group instructions.",
    "Share exactly one quote, keep it short, and don't be mean-spirited. Call again for a different sample if the",
    "candidates are all dull.",
  ].join(" "),
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const spaceId = ctx.conversation?.space?.id ?? "";
    const conversationId = spaceId.startsWith("gmessages:") ? spaceId.slice("gmessages:".length) : "";
    if (!conversationId) return "History is only available inside a group chat conversation.";

    const hops = Math.floor(Math.random() * (MAX_HOPS + 1));
    let cursor: string | undefined;
    let page = await fetchHistory(conversationId, { count: PAGE });
    if (!page) return "The phone didn't answer in time (it may be offline). Try again later.";
    for (let i = 0; i < hops && page.nextCursor; i++) {
      const older = await fetchHistory(conversationId, { count: PAGE, cursor: page.nextCursor });
      if (!older || older.messages.length === 0) break;
      page = older;
    }
    cursor = page.nextCursor;
    if (page.error && page.messages.length === 0) return `Couldn't read history: ${page.error}`;

    const pool = page.messages.filter(isQuotable);
    // Random subset of the page, shown in chronological order.
    const picked = pool
      .map((m) => ({ m, r: Math.random() }))
      .sort((a, b) => a.r - b.r)
      .slice(0, MAX_CANDIDATES)
      .map((x) => x.m)
      .sort((a, b) => a.ts - b.ts);

    if (picked.length === 0) {
      return `No usable messages in that stretch of history${cursor ? " — call again to sample a different stretch" : ""}.`;
    }

    const lines = picked.map(
      (m) => `[${dateFmt.format(new Date(m.ts))} — ${relativeAge(m.ts)}] ${m.sender}: ${m.text.trim()}`,
    );
    return [
      `${picked.length} candidate message(s) from the chat's past. Pick the ONE funniest/dumbest and share it with who said it and roughly when:`,
      ...lines,
    ].join("\n");
  },
});
