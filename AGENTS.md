# Notes for AI coding agents

- **Setting this bot up?** Follow [SETUP.md](SETUP.md) ("Instructions for the agent"). In Claude Code, `/setup` does this.
- Group-specific details (members, nicknames, owner) live only in `agent/instructions/group.md`. Keep everything else generic.
- Never print or commit secrets: Vercel env values, cookies, `.env*` files, `connector/gm.cookies.txt`.
- Layout and architecture are described in [README.md](README.md). Settings are in [.env.example](.env.example).
- Checks: `npx tsc --noEmit -p .` for the agent; `cd connector && go vet ./... && go test ./...` for the connector.
