import { createHmac, timingSafeEqual } from "node:crypto";

import { defineChannel, POST } from "eve/channels";

import { getModelMode, modelLabel, pickBackend, qwenHealthy, setModelMode, type ModelMode } from "../lib/models";
import { keys, pushOutbox, redis, type ConnectorState } from "../lib/redis";
import { toRcsText } from "../lib/rcs-format";
import { applyIntent, findPoll, parseIntent } from "../lib/polls";

// Inbound event posted by the Go connector (connector/bridge.go InboundEvent).
type InboundEvent = {
  type: "message" | "alert";
  conversationId?: string;
  conversationName?: string;
  isGroup?: boolean;
  messageId?: string;
  sender?: { id: string; name: string; number?: string; isMe: boolean };
  text?: string;
  attachments?: string[];
  media?: { key: string; mimeType: string; width: number; height: number }[];
  replyToMessageId?: string;
  participants?: string[];
  timestamp?: number;
  alert?: string;
};

type State = {
  conversationId: string;
  conversationName: string;
  isGroup: boolean;
};

// Address-style only: the message must START with "bot" (optionally after a greeting
// like "hey"/"ok"/"yo"), or contain an explicit "@bot". Talking *about* the bot
// ("what should the bot do?") doesn't trigger it.
const TRIGGER = new RegExp(
  process.env.BOT_TRIGGER ?? String.raw`^\s*(?:(?:hey|hi|yo|ok|okay|ay|aye|so|um|oh)[\s,!.]+)?@?bot\b|(?:^|[^\w@])@bot\b`,
  "i",
);
const BACKLOG_MAX = 40;
const MAX_IMAGES = 4; // images attached per turn (most recent)
const MAX_SMS_CHUNK = 1500;
const PHOTO_GRACE_MS = 1500; // a photo sent with the text shows up within ~1s
const PHOTO_WAIT_MS = 22_000; // max extra wait while the connector fetches it (connector gives up at 20s)
const TZ = process.env.BOT_TIMEZONE ?? "America/New_York";

function verify(raw: string, ts: string | null, sig: string | null, secret = process.env.GM_WEBHOOK_SECRET): boolean {
  if (!secret || !ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // replay window
  const expected = createHmac("sha256", secret).update(`${ts}.${raw}`).digest();
  const given = Buffer.from(sig, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function formatLine(evt: InboundEvent): string {
  const time = new Date(evt.timestamp ?? Date.now()).toLocaleString("en-US", {
    timeZone: TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const who = evt.sender?.isMe ? `${evt.sender.name || "Owner"} (the phone's owner)` : evt.sender?.name || "Someone";
  const photos = evt.media?.length ?? 0;
  // Media we couldn't attach (non-images, or images that failed to convert, e.g. HEIC)
  const unattached = (evt.attachments ?? []).filter((m) => !m.startsWith("image/") || photos === 0);
  const attachments =
    (photos ? ` [sent ${photos === 1 ? "a photo" : `${photos} photos`}, attached]` : "") +
    (unattached.length ? ` [sent ${unattached.join(", ")}]` : "");
  return `[${time}] ${who}: ${evt.text ?? ""}${attachments}`;
}

/** Split a long reply on paragraph/sentence boundaries so each RCS bubble stays readable. */
/**
 * One-time note on the first message after a redeploy. Without it the model
 * trusts its own earlier "that PR is still pending" over its tool list, since
 * nothing in the conversation says the code changed.
 */
async function deployNote(conv: string): Promise<string> {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  if (!sha) return "";
  const prev = await redis().get<string>(keys.deployNoted(conv));
  if (prev === sha) return "";
  await redis().set(keys.deployNoted(conv), sha);
  const lines = (process.env.VERCEL_GIT_COMMIT_MESSAGE ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  // "Merge pull request #2 from …" + PR title → "PR #2: <title>"
  const pr = lines[0]?.match(/^Merge pull request (#\d+)/);
  const summary = pr ? `PR ${pr[1]} merged: ${lines[1] ?? ""}` : (lines[0] ?? "");
  return (
    `[System note: you were redeployed since your last reply${summary ? ` (${summary.slice(0, 200)})` : ""}. ` +
    `Anything you earlier called pending or a draft may be live now: check your tool list, not past messages.]\n\n`
  );
}

function chunk(text: string): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > MAX_SMS_CHUNK) {
    const window = rest.slice(0, MAX_SMS_CHUNK);
    const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf(". "), window.lastIndexOf("\n"));
    const at = cut > MAX_SMS_CHUNK / 3 ? cut + 1 : MAX_SMS_CHUNK;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait (bounded) while the connector reports a photo in flight for this conversation. */
async function waitForPhoto(conv: string) {
  await sleep(PHOTO_GRACE_MS);
  const deadline = Date.now() + PHOTO_WAIT_MS;
  while (Date.now() < deadline && String(await redis().get(keys.photoPending(conv))) === "1") {
    await sleep(750);
  }
}

async function reply(conversationId: string, text: string, id: string) {
  await pushOutbox({ id, conversationId, text });
}

/** Bot commands handled without the model. Returns true when handled. */
async function handleCommand(evt: InboundEvent, text: string, end: () => Promise<unknown>): Promise<boolean> {
  const match = text.match(/^\/(\w+)\s*(.*)$/s);
  if (!match) return false;
  const [, command, arg] = match;
  const conv = evt.conversationId!;
  const id = `cmd:${evt.messageId}`;
  switch (command.toLowerCase()) {
    case "model": {
      const wanted = arg.trim().toLowerCase();
      if (wanted === "auto" || wanted === "qwen" || wanted === "claude") {
        await setModelMode(wanted as ModelMode);
        await reply(
          conv,
          `Model mode set to ${wanted}.` +
            (wanted === "auto" ? ` Qwen when the home PC is up, else ${modelLabel("claude")}.` : ` Using ${modelLabel(wanted as "qwen" | "claude")}.`),
          id,
        );
      } else {
        await reply(conv, `Model mode is ${await getModelMode()}. Use /model auto|qwen|claude.`, id);
      }
      return true;
    }
    case "status": {
      const [mode, healthy, backend] = await Promise.all([getModelMode(), qwenHealthy(), pickBackend()]);
      await reply(conv, `Mode: ${mode}. Qwen: ${healthy ? "up" : "down"}. Next reply uses: ${modelLabel(backend)}.`, id);
      return true;
    }
    case "new":
    case "reset": {
      await end().catch(() => undefined);
      await redis().del(keys.recent(conv));
      await reply(conv, "Started a fresh conversation (long-term memory is kept).", id);
      return true;
    }
    case "help":
      await reply(
        conv,
        "Start a message with \"bot\" (or \"hey bot\", \"@bot\") to talk to me. Commands: /status, /model auto|qwen|claude, /new, /help.",
        id,
      );
      return true;
    default:
      return false;
  }
}

export default defineChannel<State>({
  // One turn at a time per group; overlapping mentions queue instead of interrupting.
  turnPolicy: "queue",
  state: { conversationId: "", conversationName: "", isGroup: true },
  space({ state }) {
    if (!state.conversationId) return undefined;
    return {
      id: `gmessages:${state.conversationId}`,
      type: state.isGroup ? "shared" : "direct",
      visibility: "private",
    };
  },
  audience: () => "private",

  // Proactive sessions (schedules): start/resume the group's conversation; replies go out via `events` below.
  async receive({ message, target, ...send }, { from }) {
    const t = target as { conversationId: string; conversationName?: string; isGroup?: boolean };
    return await from(t.conversationId).send(message, {
      ...send,
      state: { conversationId: t.conversationId, conversationName: t.conversationName ?? "", isGroup: t.isGroup ?? true },
    });
  },

  routes: [
    POST("/gm/events", async (request, { from }) => {
      const raw = await request.text();
      if (!verify(raw, request.headers.get("x-gm-timestamp"), request.headers.get("x-gm-signature"))) {
        return new Response("unauthorized", { status: 401 });
      }
      const evt = JSON.parse(raw) as InboundEvent;

      if (evt.type === "alert") {
        console.error(`[gmessages] connector alert: ${evt.alert}`);
        return new Response("ok");
      }
      if (evt.type !== "message" || !evt.conversationId || !evt.messageId) {
        return new Response("ignored");
      }

      const conv = evt.conversationId;
      const text = (evt.text ?? "").trim();
      const line = formatLine(evt);
      const triggered = TRIGGER.test(text) || text.startsWith("/");

      // Poll intents (vote / add / status / close) are handled without the model and stay silent
      // unless the message clearly matches. Skip the bot's own 🤖 messages and slash commands.
      if (!text.startsWith("🤖") && !text.startsWith("/") && text) {
        try {
          const poll = await findPoll(conv);
          const intent = parseIntent(text.replace(TRIGGER, " "), poll);
          if (intent) {
            const reply_ = await applyIntent(conv, evt.sender?.name || evt.sender?.id || "Someone", intent);
            if (reply_) {
              await reply(conv, reply_, `poll:${evt.messageId}`);
              return new Response(null, { status: 202 });
            }
          }
        } catch (err) {
          console.error("[gmessages] poll handling failed", err);
        }
      }

      if (!triggered) {
        // Not addressed: remember it as context for the next time the bot is mentioned.
        const r = redis();
        await r.rpush(keys.recent(conv), line);
        if (evt.media?.length) {
          for (const m of evt.media) await r.rpush(keys.recentMedia(conv), JSON.stringify({ ...m, from: evt.sender?.name ?? "" }));
          await r.ltrim(keys.recentMedia(conv), -MAX_IMAGES, -1);
          await r.expire(keys.recentMedia(conv), 3 * 24 * 3600);
        }
        await r.ltrim(keys.recent(conv), -BACKLOG_MAX, -1);
        await r.expire(keys.recent(conv), 3 * 24 * 3600);
        return new Response(null, { status: 202 });
      }

      const source = from(conv);
      const commandText = text.replace(TRIGGER, " ").trim();
      if (await handleCommand(evt, text.startsWith("/") ? text : commandText, () => source.end({ reason: "/new" }))) {
        return new Response(null, { status: 202 });
      }

      await pushOutbox({ id: `typing:${evt.messageId}`, kind: "typing", conversationId: conv });
      // "bot what's this" + a photo, sent together, arrive as two messages: the
      // text first, the photo a moment later (longer for your own photos, which
      // upload from the phone first). Give a photo that's on its way a chance to land.
      const before = await redis().llen(keys.recent(conv));
      if (!evt.media?.length) await waitForPhoto(conv);

      const lines = await redis().lrange<string>(keys.recent(conv), 0, -1);
      await redis().del(keys.recent(conv));
      const backlog = lines.slice(0, before);
      const sentAfter = lines.slice(before);

      // Images: the ones posted since the bot last spoke, plus any on this message.
      const pending = (await redis().lrange<string | { key: string; mimeType: string }>(keys.recentMedia(conv), 0, -1)).map(
        (m) => (typeof m === "string" ? (JSON.parse(m) as { key: string; mimeType: string }) : m),
      );
      await redis().del(keys.recentMedia(conv));
      const refs = [...pending, ...(evt.media ?? [])].slice(-MAX_IMAGES);
      const files = (
        await Promise.all(
          refs.map(async (m) => {
            const b64 = await redis().get<string>(keys.media(m.key));
            return b64 ? { type: "file" as const, data: Buffer.from(b64, "base64"), mediaType: "image/jpeg" } : null;
          }),
        )
      ).filter((f) => f !== null);
      const message =
        (await deployNote(conv)) +
        (backlog.length || sentAfter.length
          ? [
              backlog.length ? `Messages in the group since you last spoke:\n${backlog.join("\n")}\n\n` : "",
              `New message addressed to you:\n${line}`,
              sentAfter.length ? `\n\nSent right after it (part of the same request):\n${sentAfter.join("\n")}` : "",
            ].join("")
          : line);
      await source.send(files.length ? [{ type: "text" as const, text: message }, ...files] : message, {
        // Per-sender identity from the HMAC-verified connector. `isOwner` gates
        // owner-only capabilities such as self-modification (draft PRs).
        auth: {
          authenticator: "gm-connector",
          principalType: "user",
          principalId: `gm:${evt.sender?.id ?? "unknown"}`,
          attributes: { isOwner: evt.sender?.isMe === true ? "true" : "false", name: evt.sender?.name ?? "" },
        },
        idempotencyKey: `gm:${evt.messageId}`,
        state: { conversationId: conv, conversationName: evt.conversationName ?? "", isGroup: evt.isGroup ?? true },
      });
      return new Response(null, { status: 202 });
    }),

    // ---- admin routes for the desktop gm-cookies helper (HMAC with GM_ADMIN_SECRET) ----
    POST("/gm/admin/state", async (request) => {
      const raw = await request.text();
      const h = request.headers;
      if (!verify(raw, h.get("x-gm-timestamp"), h.get("x-gm-signature"), process.env.GM_ADMIN_SECRET)) {
        return new Response("unauthorized", { status: 401 });
      }
      const [state, heartbeat] = await Promise.all([
        redis().get<ConnectorState>(keys.state),
        redis().get<number | string>(keys.heartbeat),
      ]);
      return Response.json({ ...(state ?? { state: "unknown", at: 0 }), heartbeat: Number(heartbeat ?? 0) });
    }),
    // Debug: recent events of a conversation's session (admin HMAC). Body: { conversationId, limit? }
    POST("/gm/admin/transcript", async (request, { resolveSession, attachSession }) => {
      const raw = await request.text();
      const h = request.headers;
      if (!verify(raw, h.get("x-gm-timestamp"), h.get("x-gm-signature"), process.env.GM_ADMIN_SECRET)) {
        return new Response("unauthorized", { status: 401 });
      }
      const { conversationId, limit = 80 } = JSON.parse(raw) as { conversationId: string; limit?: number };
      const session = await resolveSession(conversationId);
      if (!session) return Response.json({ error: "no active session" }, { status: 404 });
      const events: unknown[] = [];
      for await (const event of attachSession(session.id).stream({ follow: false })) {
        const e = event as unknown as { type?: string; data?: Record<string, unknown> };
        const d = e.data ?? {};
        const text = typeof d.value === "string" ? d.value : typeof d.message === "string" ? d.message : undefined;
        events.push({
          type: e.type,
          kind: d.kind,
          phase: d.phase,
          tool: (d.capability as { name?: string } | undefined)?.name ?? d.toolName ?? d.name,
          input: d.input === undefined ? undefined : JSON.stringify(d.input).slice(0, 300),
          outcome: d.outcome,
          output: d.output === undefined ? undefined : (typeof d.output === "string" ? d.output : JSON.stringify(d.output)).slice(0, 500),
          model: d.modelId ?? d.model,
          text: text?.slice(0, 600),
          error: d.error,
        });
      }
      return Response.json({ sessionId: session.id, events: events.slice(-limit) });
    }),
    // Debug: a stashed image (base64 JPEG) by message id. Body: { messageId, index? }
    POST("/gm/admin/media", async (request) => {
      const raw = await request.text();
      const h = request.headers;
      if (!verify(raw, h.get("x-gm-timestamp"), h.get("x-gm-signature"), process.env.GM_ADMIN_SECRET)) {
        return new Response("unauthorized", { status: 401 });
      }
      const { messageId, index = 0 } = JSON.parse(raw) as { messageId: string; index?: number };
      const b64 = await redis().get<string>(keys.media(`media:${messageId}:${index}`));
      if (!b64) return new Response("not found", { status: 404 });
      return new Response(Buffer.from(b64, "base64"), { headers: { "content-type": "image/jpeg" } });
    }),
    POST("/gm/admin/cookies", async (request) => {
      const raw = await request.text();
      const h = request.headers;
      if (!verify(raw, h.get("x-gm-timestamp"), h.get("x-gm-signature"), process.env.GM_ADMIN_SECRET)) {
        return new Response("unauthorized", { status: 401 });
      }
      const body = JSON.parse(raw) as { cookies?: Record<string, string>; force?: boolean };
      if (!body.cookies || typeof body.cookies !== "object") return new Response("missing cookies", { status: 400 });
      // Handed straight to the connector, which consumes it within seconds.
      await pushOutbox({ id: `cookies:${Date.now()}`, kind: "cookies", conversationId: "", cookies: body.cookies, force: body.force === true });
      return new Response(null, { status: 202 });
    }),
  ],

  events: {
    async "content.completed"(event, ctx) {
      const data = event.data as { kind?: string; phase?: string; value?: unknown };
      if (data.kind !== "text" || data.phase !== "reply" || typeof data.value !== "string") return;
      const conversationId = ctx.channel.continuation?.token;
      if (!conversationId || !data.value.trim()) return;
      const base = `${ctx.session.id}:${ctx.position.line}:${ctx.position.index}`;
      const parts = chunk(toRcsText(data.value));
      for (const [i, text] of parts.entries()) {
        await reply(conversationId, text, `${base}:${i}`);
      }
    },
  },
});
