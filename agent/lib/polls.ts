import { redis } from "./redis";

const prefix = process.env.REDIS_PREFIX ?? "gm";
const hashKey = (conv: string) => `${prefix}:polls:${conv}`; // hash: poll id -> JSON (holds many polls per chat)
const counterKey = (conv: string) => `${prefix}:polls-seq:${conv}`;
const MAX_OPTIONS = 26;

export type PollOption = { letter: string; label: string };
export type Poll = {
  id: string;
  question: string;
  options: PollOption[];
  votes: Record<string, number>; // letter -> count
  voters: Record<string, string>; // sender name -> letter (the participant set)
  closed: boolean;
  createdAt: number;
  closedAt?: number;
};

const letterAt = (i: number) => String.fromCharCode(65 + i);

async function load(conv: string): Promise<Poll[]> {
  const all = (await redis().hgetall<Record<string, Poll | string>>(hashKey(conv))) ?? {};
  return Object.values(all)
    .map((v) => (typeof v === "string" ? (JSON.parse(v) as Poll) : v))
    .sort((a, b) => a.createdAt - b.createdAt);
}
const save = (conv: string, p: Poll) => redis().hset(hashKey(conv), { [p.id]: JSON.stringify(p) });

function recount(p: Poll) {
  p.votes = Object.fromEntries(p.options.map((o) => [o.letter, 0]));
  for (const l of Object.values(p.voters)) if (l in p.votes) p.votes[l]++;
}

export async function openPolls(conv: string): Promise<Poll[]> {
  return (await load(conv)).filter((p) => !p.closed);
}
/** The last `n` polls, open or closed (oldest first). */
export async function recentPolls(conv: string, n = 5): Promise<Poll[]> {
  return (await load(conv)).slice(-n);
}
/** The most recent open poll, or the poll with this id. */
export async function findPoll(conv: string, id?: string): Promise<Poll | undefined> {
  const polls = await load(conv);
  if (id) return polls.find((p) => p.id.toLowerCase() === id.trim().toLowerCase());
  return polls.filter((p) => !p.closed).at(-1);
}

export async function startPoll(conv: string, question: string, labels: string[]): Promise<Poll> {
  const clean = labels.map((l) => l.trim()).filter(Boolean).slice(0, MAX_OPTIONS);
  const n = await redis().incr(counterKey(conv));
  const p: Poll = {
    id: `P${n}`,
    question: question.trim(),
    options: clean.map((label, i) => ({ letter: letterAt(i), label })),
    votes: {},
    voters: {},
    closed: false,
    createdAt: Date.now(),
  };
  recount(p);
  await save(conv, p);
  return p;
}

export async function addOption(conv: string, p: Poll, label: string): Promise<PollOption | null> {
  if (p.closed || p.options.length >= MAX_OPTIONS) return null;
  const clean = label.trim();
  if (!clean) return null;
  const opt = { letter: letterAt(p.options.length), label: clean };
  p.options.push(opt);
  recount(p);
  await save(conv, p);
  return opt;
}

export async function castVote(conv: string, p: Poll, voter: string, letter: string): Promise<boolean> {
  letter = letter.toUpperCase();
  if (p.closed || !p.options.some((o) => o.letter === letter)) return false;
  p.voters[voter] = letter;
  recount(p);
  await save(conv, p);
  return true;
}

export async function closePoll(conv: string, p: Poll): Promise<Poll> {
  p.closed = true;
  p.closedAt = Date.now();
  recount(p);
  await save(conv, p);
  return p;
}

export function renderOpened(p: Poll): string {
  return `Poll ${p.id} opened: ${p.question} — ${p.options.map((o) => `${o.letter}) ${o.label}`).join(" ")}`;
}

export function renderStatus(p: Poll): string {
  const names = Object.keys(p.voters);
  return [
    `Poll ${p.id}${p.closed ? " (closed)" : ""}: ${p.question}`,
    ...p.options.map((o) => `${o.letter}) ${o.label} — ${p.votes[o.letter] ?? 0}`),
    names.length ? `Voted (${names.length}): ${names.join(", ")}` : "No votes yet.",
  ].join("\n");
}

export function winnerText(p: Poll): string {
  const max = Math.max(0, ...p.options.map((o) => p.votes[o.letter] ?? 0));
  if (max === 0) return "No votes were cast, so no winner.";
  const top = p.options.filter((o) => (p.votes[o.letter] ?? 0) === max);
  const desc = top.map((o) => `${o.letter}) ${o.label}`).join(" and ");
  return top.length > 1 ? `Tie between ${desc} with ${max} vote(s) each.` : `Winner: ${desc} with ${max} vote(s).`;
}

export function renderFinal(p: Poll): string {
  return `${renderStatus(p)}\n${winnerText(p)}`;
}

export type PollIntent =
  | { kind: "vote"; letter: string }
  | { kind: "add"; label: string }
  | { kind: "status" }
  | { kind: "close" };

/** Tolerant, case-insensitive parse. Returns null when the message isn't clearly a poll intent. */
export function parseIntent(text: string, p?: Poll): PollIntent | null {
  const t = text.trim().replace(/\s+/g, " ");
  if (/^(poll status|poll results|poll tally|results|tally)[.!?]*$/i.test(t)) return { kind: "status" };
  if (!p) return null;
  if (/^(close|end|stop) (the )?poll[.!?]*$/i.test(t)) return { kind: "close" };
  const add = t.match(/^add:? (.{1,100})$/i);
  if (add) return { kind: "add", label: add[1].trim() };
  const letter = t.match(/^(?:vote(?: for)? )?\(?([a-z])[.!)]*$/i) ?? t.match(/^vote(?: for)? option ([a-z])[.!]*$/i);
  if (letter) return { kind: "vote", letter: letter[1].toUpperCase() };
  const named = t.match(/^vote(?: for)? (.{1,100}?)[.!]*$/i);
  if (named) {
    const want = named[1].trim().toLowerCase();
    const hit = p.options.find((o) => o.label.toLowerCase() === want);
    if (hit) return { kind: "vote", letter: hit.letter };
  }
  return null;
}

/** Apply a parsed intent. Returns reply text, or null to stay silent. */
export async function applyIntent(conv: string, voter: string, intent: PollIntent): Promise<string | null> {
  const p = await findPoll(conv);
  if (intent.kind === "status") return p ? renderStatus(p) : "no open poll";
  if (!p) return null;
  switch (intent.kind) {
    case "vote": {
      if (!(await castVote(conv, p, voter, intent.letter))) return null; // not a valid option: stay quiet
      return `${voter} voted ${intent.letter}.`;
    }
    case "add": {
      const o = await addOption(conv, p, intent.label);
      return o ? `Added ${o.letter}) ${o.label} to poll ${p.id}.` : null;
    }
    case "close":
      return renderFinal(await closePoll(conv, p));
  }
}
