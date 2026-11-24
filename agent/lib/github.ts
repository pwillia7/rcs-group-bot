// Server-side GitHub access for the pr_editor subagent: follow-up commits to the
// bot's own self-modification PRs. The token never reaches the model or a sandbox,
// and every call is limited to open PRs whose branch the self-modification
// extension created (eve-self-modification/...) and to files under agent/.
// Nothing here can touch main: changes still take effect only when the owner merges.

// Same repo the self-modification extension uses: SELF_MODIFICATION_REPO, else the
// repo Vercel deployed from.
const REPO = (
  process.env.SELF_MODIFICATION_REPO ??
  `${process.env.VERCEL_GIT_REPO_OWNER ?? "OWNER"}/${process.env.VERCEL_GIT_REPO_SLUG ?? "rcs-group-bot"}`
).replace(/^(https?:\/\/)?github\.com\//, "");
const BRANCH_PREFIX = "eve-self-modification/";

/** Paths the editor may never change: the guardrails themselves. */
const PROTECTED = ["agent/extensions/", "agent/subagents/pr_editor/", "agent/lib/github.ts"];

export class GitHubError extends Error {}

function token(): string {
  const t = process.env.EVE_SELF_MODIFICATION_GITHUB_TOKEN;
  if (!t) throw new GitHubError("EVE_SELF_MODIFICATION_GITHUB_TOKEN is not set.");
  return t;
}

async function gh<T>(method: string, path: string, body?: unknown, allow404 = false): Promise<T | null> {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token()}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (allow404 && res.status === 404) return null;
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GitHubError(`GitHub ${method} ${path} failed: HTTP ${res.status} ${detail.slice(0, 300)}`);
  }
  return res.status === 204 ? (null as T) : ((await res.json()) as T);
}

type RawPull = {
  number: number;
  title: string;
  html_url: string;
  draft: boolean;
  state: string;
  body: string | null;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { ref: string };
};

export type BotPr = { number: number; title: string; url: string; branch: string; headSha: string; draft: boolean; body: string };

function toBotPr(p: RawPull): BotPr | null {
  const sameRepo = p.head.repo?.full_name.toLowerCase() === REPO.toLowerCase();
  if (p.state !== "open" || !sameRepo || !p.head.ref.startsWith(BRANCH_PREFIX)) return null;
  return { number: p.number, title: p.title, url: p.html_url, branch: p.head.ref, headSha: p.head.sha, draft: p.draft, body: p.body ?? "" };
}

/** Open PRs the bot opened through self-modification, newest first. */
export async function listBotPrs(): Promise<BotPr[]> {
  const pulls = (await gh<RawPull[]>("GET", "/pulls?state=open&per_page=50&sort=created&direction=desc")) ?? [];
  return pulls.map(toBotPr).filter((p): p is BotPr => p !== null);
}

export async function getBotPr(number: number): Promise<BotPr> {
  const raw = await gh<RawPull>("GET", `/pulls/${number}`, undefined, true);
  const pr = raw && toBotPr(raw);
  if (!pr) throw new GitHubError(`PR #${number} isn't an open bot PR (branch ${BRANCH_PREFIX}...), so it can't be edited.`);
  return pr;
}

export async function prChangedFiles(number: number): Promise<{ path: string; status: string }[]> {
  const files = (await gh<{ filename: string; status: string }[]>("GET", `/pulls/${number}/files?per_page=100`)) ?? [];
  return files.map((f) => ({ path: f.filename, status: f.status }));
}

/** Normalizes a repo path and rejects anything outside agent/ or inside the guardrails. */
export function checkPath(raw: string, forWrite: boolean): string {
  const path = raw.trim().replace(/^\.?\/+/, "");
  if (!path || path.split("/").some((s) => s === ".." || s === "." || s === "")) throw new GitHubError(`Bad path "${raw}".`);
  if (!path.startsWith("agent/")) throw new GitHubError(`Only files under agent/ can be ${forWrite ? "changed" : "read"} ("${path}").`);
  if (forWrite && PROTECTED.some((p) => path === p || path.startsWith(p))) {
    throw new GitHubError(`"${path}" is protected; only the owner can change it directly.`);
  }
  return path;
}

const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

/** A file's text at a ref, a directory listing, or null if it doesn't exist. */
export async function readPath(path: string, ref: string): Promise<{ kind: "file"; text: string } | { kind: "dir"; entries: string[] } | null> {
  const data = await gh<unknown>("GET", `/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`, undefined, true);
  if (data === null) return null;
  if (Array.isArray(data)) return { kind: "dir", entries: data.map((e: { name: string; type: string }) => (e.type === "dir" ? `${e.name}/` : e.name)) };
  const file = data as { type: string; content?: string; encoding?: string; size: number };
  if (file.type !== "file" || file.encoding !== "base64" || file.content === undefined) {
    throw new GitHubError(`${path} isn't a readable text file (type ${file.type}, ${file.size} bytes).`);
  }
  return { kind: "file", text: Buffer.from(file.content, "base64").toString("utf8") };
}

export type Change =
  | { path: string; content: string }
  | { path: string; delete: true }
  | { path: string; edits: { find: string; replace: string }[] };

/**
 * Applies all changes as one commit on the PR's branch. Fast-forward only: if the
 * branch moved since `expectedHeadSha`, nothing is written.
 */
export async function commitToBotPr(input: {
  number: number;
  changes: Change[];
  message: string;
  expectedHeadSha?: string;
}): Promise<{ commitSha: string; commitUrl: string; paths: string[]; pr: BotPr }> {
  const pr = await getBotPr(input.number);
  if (input.expectedHeadSha && !pr.headSha.startsWith(input.expectedHeadSha)) {
    throw new GitHubError(`PR #${pr.number} changed since you read it (now at ${pr.headSha.slice(0, 7)}). Re-read and try again.`);
  }
  if (!input.changes.length) throw new GitHubError("No changes given.");

  const seen = new Set<string>();
  const tree: { path: string; mode: "100644"; type: "blob"; content?: string; sha?: null }[] = [];
  for (const change of input.changes) {
    const path = checkPath(change.path, true);
    if (seen.has(path)) throw new GitHubError(`${path} appears twice; combine its edits into one change.`);
    seen.add(path);

    if ("delete" in change) {
      if (!(await readPath(path, pr.headSha))) throw new GitHubError(`Can't delete ${path}: it doesn't exist on the branch.`);
      tree.push({ path, mode: "100644", type: "blob", sha: null });
    } else if ("edits" in change) {
      const current = await readPath(path, pr.headSha);
      if (current?.kind !== "file") throw new GitHubError(`Can't edit ${path}: no such file on the branch.`);
      let text = current.text;
      for (const { find, replace } of change.edits) {
        const count = find ? text.split(find).length - 1 : 0;
        if (count !== 1) {
          throw new GitHubError(`In ${path}, the text to replace must appear exactly once but appears ${count} times: ${JSON.stringify(find.slice(0, 120))}`);
        }
        text = text.replace(find, () => replace);
      }
      tree.push({ path, mode: "100644", type: "blob", content: text });
    } else {
      tree.push({ path, mode: "100644", type: "blob", content: change.content });
    }
  }

  const head = await gh<{ tree: { sha: string } }>("GET", `/git/commits/${pr.headSha}`);
  const newTree = await gh<{ sha: string }>("POST", "/git/trees", { base_tree: head!.tree.sha, tree });
  if (newTree!.sha === head!.tree.sha) throw new GitHubError("Those changes don't change anything on the branch.");
  const commit = await gh<{ sha: string; html_url: string }>("POST", "/git/commits", {
    message: input.message,
    tree: newTree!.sha,
    parents: [pr.headSha],
  });
  // force: false makes GitHub reject the update if the branch moved meanwhile.
  await gh("PATCH", `/git/refs/heads/${encodePath(pr.branch)}`, { sha: commit!.sha, force: false });
  return { commitSha: commit!.sha, commitUrl: commit!.html_url, paths: [...seen], pr };
}

/** Leaves a visible note on the PR so follow-up pushes can't slip in unnoticed. */
export async function commentOnPr(number: number, body: string): Promise<void> {
  await gh("POST", `/issues/${number}/comments`, { body });
}
