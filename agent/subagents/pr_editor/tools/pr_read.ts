import { defineTool } from "eve/tools";
import { z } from "zod";

import { checkPath, getBotPr, prChangedFiles, readPath } from "../../../lib/github";

const MAX_CHARS = 60_000;

export default defineTool({
  description: [
    "Read from an open bot PR's branch. Without `path`: the PR's title, description, head commit and changed files.",
    "With `path` (under agent/): that file's full text with line numbers, or a directory listing.",
  ].join(" "),
  inputSchema: z.object({
    pr: z.number().int().positive().describe("PR number."),
    path: z.string().optional().describe("Repo-relative path under agent/, e.g. agent/lib/polls.ts."),
  }),
  async execute({ pr, path }) {
    const p = await getBotPr(pr);
    if (!path) {
      const files = await prChangedFiles(pr);
      return [
        `PR #${p.number}: ${p.title} (${p.draft ? "draft" : "ready for review"})`,
        `Branch ${p.branch}, head commit ${p.headSha.slice(0, 12)}. ${p.url}`,
        `Changed files:\n${files.map((f) => `- ${f.path} (${f.status})`).join("\n")}`,
        `Description:\n${p.body.slice(0, 4_000)}`,
      ].join("\n");
    }
    const clean = checkPath(path, false);
    const got = await readPath(clean, p.headSha);
    if (!got) return `${clean} doesn't exist on PR #${pr}'s branch.`;
    if (got.kind === "dir") return `${clean}/ (head ${p.headSha.slice(0, 12)}):\n${got.entries.join("\n")}`;
    const numbered = got.text
      .split("\n")
      .map((line, i) => `${String(i + 1).padStart(4)}  ${line}`)
      .join("\n");
    const cut = numbered.length > MAX_CHARS ? `${numbered.slice(0, MAX_CHARS)}\n[truncated]` : numbered;
    return `${clean} at head ${p.headSha.slice(0, 12)} (line numbers are for reference, not part of the file):\n${cut}`;
  },
});
