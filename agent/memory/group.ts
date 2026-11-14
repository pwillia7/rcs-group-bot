import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";

// One shared notes document per group chat (Vercel Blob in production).
// Model-agnostic: Qwen and Claude both read and edit the same document.
export default defineMemory({
  description:
    "Long-term notes about this group chat and its members: names, preferences, recurring plans, inside jokes, and anything someone asks you to remember.",
  provider: fileMemory({ maxCharacters: 8_000 }),
  scope: (ctx) => {
    const space = ctx.conversation?.space;
    return space?.id ?? null;
  },
});
