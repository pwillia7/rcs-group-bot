import { randomUUID } from "node:crypto";

import { defineTool } from "eve/tools";
import { z } from "zod";

import { searchGifs } from "../lib/gifs";
import { replyEmoji } from "../lib/models";
import { keys, pushOutbox, redis } from "../lib/redis";

// Posts an animated GIF (or any image/short video) to the group as a real
// attachment. The connector downloads the URL and uploads it to Google
// Messages (connector/sendmedia.go). No API key needed: search reads Tenor's
// public search page, falling back to Giphy's.
export default defineTool({
  description:
    "Post an animated GIF to the group chat as a real attachment. Give `query` to search (Tenor, then Giphy; no content filter beyond the site's default) or `url` to send a specific GIF/image/video you found some other way (any public https link, e.g. from web_search). Use `preview: true` first to see the top results' descriptions when the pick matters, then send with `pick`. The GIF is posted right away. If all they asked for was the GIF, it is your whole reply: leave `answer` off and call no_reply (any text after it is dropped). If they also asked something you must answer in text (\"send a gif and tell me who that is\"), set `answer: true` and then reply with just that answer, not commentary on the GIF. You can't see the GIF itself, only its description.",
  inputSchema: z.object({
    query: z
      .string()
      .min(2)
      .optional()
      .describe("What the GIF should show, e.g. 'dexter cant prove it'."),
    url: z
      .string()
      .url()
      .optional()
      .describe(
        "Direct https link to a GIF/image/video file to send instead of searching.",
      ),
    pick: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe("Which search result to send (1 = best match, default 1)."),
    preview: z
      .boolean()
      .optional()
      .describe("List the top results without posting."),
    caption: z
      .string()
      .max(300)
      .optional()
      .describe("Optional short text sent with the GIF."),
    answer: z
      .boolean()
      .optional()
      .describe(
        "true when the request also asks a question you'll answer in text after the GIF. Otherwise your text after the GIF is dropped.",
      ),
  }),
  async execute({ query, url, pick = 1, preview, caption, answer }, ctx) {
    if (!query && !url) return "Give a query or a url.";
    const spaceId = ctx.conversation?.space?.id ?? "";
    const conv = spaceId.startsWith("gmessages:")
      ? spaceId.slice("gmessages:".length)
      : "";
    if (!conv && !preview)
      return "GIFs can only be posted inside the group chat.";

    let chosen: { url: string; description: string };
    if (url) {
      if (!url.startsWith("https://")) return "The url must be https.";
      chosen = { url, description: "your link" };
    } else {
      const { gifs, errors } = await searchGifs(query!);
      if (!gifs.length) {
        return `No GIFs found for "${query}" (${errors.join("; ")}). Try other wording, or find one with web_search and send it by url.`;
      }
      if (preview) {
        return gifs
          .slice(0, 8)
          .map(
            (g, i) =>
              `${i + 1}. ${g.description || "(no description)"} [${g.source}${g.seconds ? `, ${g.seconds}s` : ""}${g.bytes ? `, ${(g.bytes / 1e6).toFixed(1)} MB` : ""}]`,
          )
          .join("\n");
      }
      chosen = gifs[Math.min(pick, gifs.length) - 1];
    }
    if (preview) return `Would send ${chosen.url}`;

    await pushOutbox({
      id: `gif:${randomUUID()}`,
      conversationId: conv,
      mediaUrl: chosen.url,
      // Marked with the emoji of the model that chose it, like a text reply.
      text: caption ? `${await replyEmoji()} ${caption}` : await replyEmoji(),
    });
    if (answer) {
      return `Queued the GIF (${chosen.description || chosen.url}); it appears in the chat in a few seconds. Now reply with just the answer they asked for; don't mention or describe the GIF.`;
    }
    await redis().set(keys.gifSent(conv), "1", { ex: 300 });
    return `Queued the GIF (${chosen.description || chosen.url}); it appears in the chat in a few seconds. The GIF is your whole reply: call no_reply now (any text you write is dropped).`;
  },
});
