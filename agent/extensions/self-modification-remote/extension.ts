import selfModification from "eve/extensions/self-modification/remote";

// Lets the bot write new tools/skills/instructions for itself, as a *draft PR*
// on your copy of this repo. It never touches the running deployment; the owner
// reviews and merges (GitHub → Vercel deploys). Any group member can request a PR:
// only allowlisted group messages reach the agent, via the HMAC-verified connector.
//
// The repo defaults to the one Vercel deployed from (VERCEL_GIT_REPO_OWNER/SLUG);
// override with SELF_MODIFICATION_REPO=github.com/<owner>/<repo>. Requires
// EVE_SELF_MODIFICATION_GITHUB_TOKEN. Delete this folder to turn the feature off.
const repository =
  process.env.SELF_MODIFICATION_REPO ??
  `github.com/${process.env.VERCEL_GIT_REPO_OWNER ?? "OWNER"}/${process.env.VERCEL_GIT_REPO_SLUG ?? "rcs-group-bot"}`;

export default selfModification({
  source: { git: { repository, directory: "." } },
  target: { branch: "main" },
  credentials: { pat: true }, // EVE_SELF_MODIFICATION_GITHUB_TOKEN (fine-grained, this repo only)
  authorize: ({ principal }) => principal?.authenticator === "gm-connector" && principal.principalType === "user",
});
