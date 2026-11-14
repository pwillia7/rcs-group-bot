import browser from "@eve/agent-browser";

// Real Chromium inside the bot's Vercel Sandbox (agent-browser), for pages that
// need JavaScript: showtimes, menus, store hours, live scores, etc.
// contentBoundaries marks page text as untrusted content (prompt-injection guard).
export default browser({
  contentBoundaries: true,
  maxOutputChars: 20_000,
});
