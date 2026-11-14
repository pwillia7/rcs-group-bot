import { defineSchedule } from "eve/schedules";

import gmessages from "../channels/gmessages";

// Posts one "stupid quote" from the chat's past to the group every day at 9 AM
// (BOT_TIMEZONE). Set GM_CONVERSATION_ID (the group's conversation ID) on the agent,
// or ALLOWED_CONVERSATIONS. Set DAILY_QUOTE=off to disable.
const PROMPT = [
  "It's the daily stupid-quote post. Call the stupid_quote tool and share exactly one funny/dumb quote from the chat's past,",
  "saying who said it and roughly when. Keep it to a line or two, with a brief playful intro.",
  "Credit the person by the name or nickname from your group instructions.",
  "If the tool can't find a quote, post nothing (no apology, no explanation).",
].join(" ");

export default defineSchedule({
  cron: "0 9 * * *",
  timezone: process.env.BOT_TIMEZONE ?? "America/New_York",
  async run({ to, waitUntil, appAuth }) {
    if (process.env.DAILY_QUOTE === "off") return;
    const conversationId = process.env.GM_CONVERSATION_ID ?? process.env.ALLOWED_CONVERSATIONS?.split(",")[0]?.trim();
    if (!conversationId) {
      console.warn("[daily-stupid-quote] GM_CONVERSATION_ID is not set; skipping.");
      return;
    }
    const day = new Date().toISOString().slice(0, 10);
    waitUntil(
      to(gmessages, { conversationId }).send(PROMPT, {
        auth: appAuth,
        idempotencyKey: `schedule:daily-stupid-quote:${day}`,
      }),
    );
  },
});
