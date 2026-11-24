import { defineAgent } from "eve";

import { FALLBACK_MODEL } from "../../lib/models";

// Follow-up edits to the bot's own open self-modification PRs. Always runs on Claude,
// never on local Qwen, since it writes code. Static on purpose: eve rejects
// `defaultTools` in a dynamic (defineDynamic) subagent at runtime, which failed every
// turn. Each tool checks that the caller is a group member instead (see requireGroupMember).
export default defineAgent({
  description: [
    "Change one of the bot's own open draft pull requests (the ones self-modification opened) by pushing a follow-up commit to that PR's branch, instead of opening a new PR.",
    "Delegate here when someone asks to fix, tweak, or add to an existing bot PR (\"update the trivia PR\", \"in that PR, make it 9AM\", \"PR #5 should also track ties\").",
    "Include the PR number if known (or enough to identify it), exactly what to change, and who asked.",
    "It can only edit files under agent/ on open bot PR branches; it never touches main, merges, or deploys.",
  ].join(" "),
  model: FALLBACK_MODEL,
  reasoning: "medium",
  defaultTools: false,
});
