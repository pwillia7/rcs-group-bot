# Setup guide (for you and your AI coding agent)

**Easiest way:** open this repo in an AI coding agent such as [Claude Code](https://claude.com/claude-code) and say:

> Set up this bot for me by following SETUP.md.

In Claude Code you can also run `/setup`. The agent runs the commands, generates and stores the secrets, deploys, and pauses only when it needs you: signing in to Google, tapping an emoji on your phone, and picking your group chat. Budget about 30–45 minutes.

You can also follow the steps by hand. Everything below works from a normal terminal.

---

## Instructions for the agent

You are setting up an AI bot that joins one Google Messages (RCS) group chat through the user's own Android phone. Work through the steps in order and check each one before moving on.

**Ground rules**

- **Never print secrets** (keys, tokens, cookies) in chat or logs. Pipe them straight into `vercel env add`. Never commit `.env*` files or cookie files; `.gitignore` already covers them.
- **Ask before you spend money or change accounts**: creating a Vercel project, installing Marketplace integrations, upgrading a plan.
- **Stop and hand over to the user** at the steps marked 🧑. Explain exactly what to do, wait for them to confirm, then continue.
- Prefer `gh` and `vercel` CLI commands over asking the user to click through dashboards. If a CLI is missing or logged out, ask the user to run `! gh auth login` or `! vercel login` themselves.
- If a step fails, read the error, fix the cause, and retry. Don't skip steps. Debugging tips are under "Troubleshooting" at the end.

### Step 0: Check prerequisites

Confirm with the user, and with commands where possible:

- An **Android phone** with Google Messages as the default SMS app, **RCS chats turned on**, and the group chat the bot should join. iPhones can't host the bot, but iPhone users can be in the group.
- A **Vercel account on the Pro plan**. The connector runs 24/7 as a Vercel Daemon, which Hobby's quota can't cover. AI Gateway usage is billed separately, roughly a cent or two per reply on Claude Sonnet.
- A **GitHub account**, with `gh` installed and logged in (`gh auth status`).
- **Node.js 26+**, **Go 1.27+** (to build the connector for pairing), **openssl**, and the **Vercel CLI** (`npm i -g vercel`, `vercel whoami`).
- **Google Chrome** on a computer, for the one-time cookie copy in step 6.

### Step 1: Make the user's own copy (private)

The group file will contain real names, so the copy must be **private**.

```bash
gh repo create <name> --private --template pwillia7/rcs-group-bot --clone
cd <name>
npm install
```

If this checkout is already the user's own private repo, skip this step.

### Step 2: 🧑 Describe the group

Ask the user for:

- each member's name **as it appears in the owner's contacts**, plus any nickname or "always/never call them X" rules
- who owns the phone
- their timezone (an IANA name such as `America/Chicago`)

Rewrite `agent/instructions/group.md` from their answers, keeping its structure. Commit it.

### Step 3: Create the Vercel project and storage

```bash
vercel link                                  # create a new project; accept the defaults
vercel git connect                           # deploy from the GitHub repo on push
vercel integration add upstash/upstash-kv    # Upstash Redis: sets REDIS_URL, KV_REST_API_URL, KV_REST_API_TOKEN
vercel blob create-store <name>-memory       # Vercel Blob for group notes: connect it to this project (Production)
```

Check with `vercel env ls production` that `REDIS_URL`, `KV_REST_API_URL`, `KV_REST_API_TOKEN` and `BLOB_READ_WRITE_TOKEN` exist.

### Step 4: Secrets and settings

Generate the secrets and add each one without echoing it:

```bash
scripts/gen-secrets.sh > /tmp/bot-secrets && chmod 600 /tmp/bot-secrets
while IFS='=' read -r k v; do printf '%s' "$v" | vercel env add "$k" production; done < /tmp/bot-secrets
rm /tmp/bot-secrets
printf '%s' '<IANA timezone>' | vercel env add BOT_TIMEZONE production
```

Recommended: phone alerts with [ntfy](https://ntfy.sh). Have the user install the ntfy app and subscribe to a long random topic. Then set `NTFY_URL=https://ntfy.sh/<topic>`, generating the topic with `openssl rand -hex 12`. Without it, the bot can't tell anyone when it needs attention.

All settings are documented in `.env.example`.

### Step 5: First deploy

```bash
vercel deploy --prod
```

Note the production URL (for example `https://<project>.vercel.app`). Then:

```bash
printf '%s' 'https://<project>.vercel.app/gm/events' | vercel env add WEBHOOK_URL production
```

The connector daemon starts but has no Google session yet. That's expected. Next, stop it while you pair, because only one session can be active at a time:

```bash
vercel daemons scale gm-connector iad1=0
```

### Step 6: 🧑 Pair with the phone

Give the user these steps, in this order:

1. Open an **Incognito** Chrome window and sign in at https://messages.google.com with the **same Google account** the phone's Messages uses. If it offers to pair, ignore it.
2. Open DevTools (F12) → **Network** → filter **Fetch/XHR**. Reload, then right-click any request to `instantmessaging-pa.clients6.google.com` → **Copy → Copy as cURL (bash)**.
3. Paste it into a new file `connector/gm.cookies.txt` (it's gitignored).
4. In DevTools → **Application** → **Cookies** → `https://messages.google.com`, copy the `OSID` value. Add a line `OSID=<value>` at the end of the same file.
5. Close the window **without signing out**. Signing out invalidates the cookies.

Then build and pair. Pull the production env into a gitignored file so the connector can reach the same Redis:

```bash
vercel env pull .env.pairing --environment=production --yes
cd connector && go build -o gm-connector .
set -a && . ../.env.pairing && set +a
./gm-connector pair < gm.cookies.txt
```

🧑 An emoji prints in the terminal. The user taps the **same emoji** in Google Messages on the phone. The command exits with "paired and session saved". Delete the cookie file now:

```bash
rm gm.cookies.txt
```

### Step 7: 🧑 Pick the group

In the same shell (the env from step 6 is still loaded):

```bash
./gm-connector list
rm ../.env.pairing          # done with local secrets
```

This prints conversation IDs and names. Ask the user which one is the group, then:

```bash
printf '%s' '<conversation id>' | vercel env add ALLOWED_CONVERSATIONS production
cd .. && vercel deploy --prod
vercel daemons scale gm-connector iad1=2
```

Two instances on purpose: one holds the Google session and the other is a hot standby that takes over within seconds if Vercel stops the first. A Redis lease makes sure only one is ever connected.

The connector ignores every conversation not in `ALLOWED_CONVERSATIONS`.

### Step 8: 🧑 Test

Have the user send `bot hi` in the group. Also try `/status`, then a photo with "bot what's in this photo?". Replies arrive from the owner's number, starting with 🤖.

If nothing comes back, run `vercel logs --since 10m --query 'source:daemon'`. You should see "connected" and then "forwarding message". Check the Troubleshooting section below.

### Step 9: Optional extras (ask the user which they want)

- **Automatic cookie refresh (recommended if they have an always-on Windows PC).** Google expires the session a few times a day. Without this helper, someone has to redo step 6 when ntfy says the bot is offline. With it, recovery happens on its own within about 2 minutes. On the PC: build `desktop/gm-cookies` (`GOOS=windows go build -ldflags -H=windowsgui .`, so the scheduled run doesn't flash a console window every 2 minutes), put `gm-cookies.exe` in `%USERPROFILE%\rcs-group-bot\` along with `admin-secret.txt` (the `GM_ADMIN_SECRET` value) and `api-url.txt` (the production URL). Then run `gm-cookies.exe -login` once to sign the dedicated Chrome profile in, and run `Install-GmCookies.ps1`.
- **Local model on a GPU PC** (`desktop/qwen-bot`, needs about 24 GB VRAM). Replies use your own Qwen when the PC is up and fall back to Claude when it isn't. Install llama.cpp, download the GGUF and its mmproj (for vision), edit `config.ps1`. If the stock model refuses too many ordinary group requests, an abliterated build of the same model (for example huihui-ai's) drops in with the same mmproj and alias; keep the stock file for rollback. Run `Install-QwenBot.ps1` and `Install-Shortcuts.ps1`. Expose it with `tailscale funnel --https=10000 --bg 18081`, then set `QWEN_BASE_URL`, `QWEN_API_KEY` and `MODEL_CONTEXT_WINDOW`.
- **Self-modification.** Group members can ask the bot for new features, and it opens draft PRs on the user's repo. Create a fine-grained GitHub token for this repo only (Contents and Pull requests: read/write) and set it as `EVE_SELF_MODIFICATION_GITHUB_TOKEN`. To turn the feature off entirely, delete `agent/extensions/self-modification-remote/`.
- **No daily quote:** set `DAILY_QUOTE=off`.

### Troubleshooting

| Symptom | Fix |
|---|---|
| Daemon logs "no usable session" / state `need-cookies` | Redo step 6 (or install the cookie helper). |
| Logs say "re-pair needed" | The pairing was removed on the phone. Redo step 6. |
| "Another session active" / messages missed | Two connectors are running. Make sure you scaled to 0 before `pair`/`list`, and that only one deployment's daemon runs. |
| Bot sees photos as tiny or blurry | Check the "media fetched" log lines: `out_w`/`out_h` should be hundreds of pixels. |
| Webhook 401s in logs | `WEBHOOK_SECRET` and `GM_WEBHOOK_SECRET` differ. Set both to the same value and redeploy. |
| `/status` says the model is down | Without a local model that's normal: replies use `FALLBACK_MODEL` via AI Gateway. |
