import { installAgentBrowser } from "@eve/agent-browser/sandbox";
import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";

// Prepared template: Chromium + agent-browser are installed once at deploy time
// (snapshot), so a group's first browser call doesn't wait on a download.
export const environment = VercelSandbox.environment({
  prepare: async (sandbox) => {
    await installAgentBrowser(sandbox);
  },
});

export default defineSandbox(() => environment.open());
