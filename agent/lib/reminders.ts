import { randomUUID } from "node:crypto";

import { pushOutbox, redis } from "./redis";

const prefix = process.env.REDIS_PREFIX ?? "gm";
const KEY = `${prefix}:reminders`; // sorted set: score = due time (unix ms), member = JSON
export const TZ = process.env.BOT_TIMEZONE ?? "America/Chicago";

export type Repeat = "none" | "daily" | "weekdays" | "weekly";
export type Reminder = {
  id: string;
  conversationId: string;
  text: string;
  by: string;
  dueAt: number; // unix ms
  repeat: Repeat;
};

/** Offset (ms) of `tz` from UTC at instant `utcMs`. */
function tzOffset(utcMs: number, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(utcMs))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - utcMs;
}

/** Parse "YYYY-MM-DDTHH:mm" as wall-clock time in the group's timezone (or any ISO string with an offset). */
export function parseLocal(input: string): number | null {
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(input)) {
    const t = Date.parse(input);
    return Number.isNaN(t) ? null : t;
  }
  const m = input.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
  let utc = guess - tzOffset(guess, TZ);
  utc = guess - tzOffset(utc, TZ); // second pass handles DST edges
  return utc;
}

export function formatLocal(ms: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));
}

export function nowLocal(): string {
  return formatLocal(Date.now()) + ` (${TZ})`;
}

function nextOccurrence(r: Reminder): number | null {
  const day = 86_400_000;
  if (r.repeat === "daily") return r.dueAt + day;
  if (r.repeat === "weekly") return r.dueAt + 7 * day;
  if (r.repeat === "weekdays") {
    let next = r.dueAt + day;
    while (["Sat", "Sun"].includes(new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(next))) {
      next += day;
    }
    return next;
  }
  return null;
}

export async function addReminder(r: Omit<Reminder, "id">): Promise<Reminder> {
  const reminder = { ...r, id: randomUUID().slice(0, 8) };
  await redis().zadd(KEY, { score: reminder.dueAt, member: JSON.stringify(reminder) });
  return reminder;
}

export async function listReminders(conversationId: string): Promise<Reminder[]> {
  const raw = await redis().zrange<(string | Reminder)[]>(KEY, 0, -1);
  return raw
    .map((m) => (typeof m === "string" ? (JSON.parse(m) as Reminder) : m))
    .filter((r) => r.conversationId === conversationId);
}

export async function cancelReminder(conversationId: string, id: string): Promise<Reminder | null> {
  const all = await redis().zrange<(string | Reminder)[]>(KEY, 0, -1);
  for (const m of all) {
    const r = typeof m === "string" ? (JSON.parse(m) as Reminder) : m;
    if (r.id === id && r.conversationId === conversationId) {
      await redis().zrem(KEY, typeof m === "string" ? m : JSON.stringify(m));
      return r;
    }
  }
  return null;
}

/** Post every due reminder exactly once (ZREM decides the winner), rescheduling repeats. */
export async function fireDueReminders(): Promise<number> {
  const due = await redis().zrange<(string | Reminder)[]>(KEY, 0, Date.now(), { byScore: true });
  let fired = 0;
  for (const m of due) {
    const member = typeof m === "string" ? m : JSON.stringify(m);
    if ((await redis().zrem(KEY, member)) !== 1) continue; // another run took it
    const r = typeof m === "string" ? (JSON.parse(m) as Reminder) : m;
    await pushOutbox({
      id: `reminder:${r.id}:${r.dueAt}`,
      conversationId: r.conversationId,
      text: `⏰ Reminder (from ${r.by}): ${r.text}`,
    });
    fired++;
    const next = nextOccurrence(r);
    if (next) await redis().zadd(KEY, { score: next, member: JSON.stringify({ ...r, dueAt: next }) });
  }
  return fired;
}
