import { defineTool } from "eve/tools";
import { z } from "zod";

import { commentOnPr, commitToBotPr, type Change } from "../../../lib/github";

const change = z.union([
  z.object({
    path: z.string(),
    edits: z
      .array(z.object({ find: z.string().min(1), replace: z.string() }))
      .min(1)
      .describe("Exact find/replace pairs, applied in order; each `find` must appear exactly once in the file."),
  }),
  z.object({ path: z.string(), content: z.string().describe("Full new file content (new files or full rewrites).") }),
  z.object({ path: z.string(), delete: z.literal(true) }),
]);

export default defineTool({
  description: [
    "Push one follow-up commit with all the given file changes to an open bot PR's branch. Only files under agent/.",
    "Fails without writing anything if the branch moved since expectedHeadSha, if an edit's `find` text isn't found exactly once, or if a path is protected.",
    "Also leaves a comment on the PR naming who asked.",
  ].join(" "),
  inputSchema: z.object({
    pr: z.number().int().positive(),
    message: z.string().min(1).max(500).describe("Commit message: what changed, one or two lines."),
    requestedBy: z.string().min(1).max(80).describe("Name of the group member who asked for the change."),
    expectedHeadSha: z.string().regex(/^[0-9a-f]{7,40}$/).describe("Head commit pr_read reported."),
    changes: z.array(change).min(1).max(20),
  }),
  async execute({ pr, message, requestedBy, expectedHeadSha, changes }, ctx) {
    const auth = ctx.session.auth.current;
    if (auth?.authenticator !== "gm-connector" || auth.principalType !== "user") {
      return "Only group members can change bot PRs.";
    }
    // Prefer the verified sender name from the connector over the model's claim.
    const verifiedName = typeof auth.attributes.name === "string" && auth.attributes.name ? auth.attributes.name : null;
    const who = verifiedName ?? requestedBy;

    try {
      const result = await commitToBotPr({
        number: pr,
        changes: changes as Change[],
        message: `${message.trim()}\n\nRequested in the group chat by ${who}.`,
        expectedHeadSha,
      });
      await commentOnPr(
        pr,
        `Follow-up commit ${result.commitSha.slice(0, 7)} pushed from the group chat, requested by ${who}:\n\n> ${message.trim().replace(/\n/g, "\n> ")}\n\nFiles: ${result.paths.map((p) => `\`${p}\``).join(", ")}. Not type-checked; see the Vercel preview check.`,
      ).catch((e) => console.warn("[pr_commit] comment failed", e));
      return `Pushed ${result.commitSha.slice(0, 12)} to PR #${pr} (${result.paths.join(", ")}). ${result.pr.url}`;
    } catch (e) {
      return `Commit failed, nothing was written: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});
