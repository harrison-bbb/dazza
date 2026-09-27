# Security

Dazza runs a coding agent on your machine with permission to edit files and run commands. This page covers what that means, where secrets are kept, and what leaves your machine.

## Where secrets live

Per-user config lives in `~/.config/dazza` (or `$XDG_CONFIG_HOME/dazza`, or `$DAZZA_CONFIG_DIR`). The directory is created with mode `0700`, and every file in it is written `0600`, atomically.

| File | Holds |
|---|---|
| `connection.json` | Which agent Dazza uses, and the API key if you connected with one |
| `telegram.json` | Your Telegram bot token and chat id |
| `slack.json` | Your Slack bot token and app-level token, and the linked user (with the Slack integration) |
| `settings.json` | Preferences, e.g. the model. No secrets |
| `limits.json` | The latest subscription usage reading. No secrets |

Tokens are plain text in these files, protected only by file permissions. Anyone who can read your home directory as you can read them. Moving them to the OS keychain is planned.

On a subscription connection, Dazza never sees your Claude or ChatGPT credentials. The agent CLI keeps its own sign-in. Dazza also strips `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `CODEX_API_KEY` from the agent's environment, so a key left in your shell can't switch billing without you knowing.

Tokens are never put in log output. The Telegram token is part of every Bot API URL, so errors report Telegram's description only, never the URL.

Project state in `.dazza/` holds no secrets unless you paste one into the chat or a comment, for example to unblock a task that needs a key. Comments are stored in `.dazza/events.jsonl` and passed to the agent. Treat a pasted secret the way you'd treat one pasted into Claude Code or Codex directly.

## What agents can do

There are two agent sessions. See [architecture.md](architecture.md).

**The manager** (the conversation) can read your code and use Dazza's planning tools. It can't edit code or run commands.
- Claude Code: `--allowedTools Read,Glob,Grep,<dazza tools>`. In a headless run, anything else that needs permission is denied.
- Codex: `-s read-only` with `approval_policy="never"`.

**The worker** (the builder) edits files and runs commands without asking you.
- Claude Code: `--permission-mode auto`. Claude Code's own safety checks decide what's too risky and block it.
- Codex: `--approve-for-me`, which is the workspace-write sandbox with automatic approval review, plus network access (`sandbox_workspace_write.network_access=true`) so it can install dependencies.

Be clear about what that means. During `/build`, the agent runs shell commands on your machine, as you, without a prompt for each one. Dazza relies on the agent CLI's own safeguards for which commands are allowed. It doesn't add a sandbox of its own. Build in projects you'd be comfortable letting Claude Code or Codex work on unattended, and don't build with production credentials in your environment.

Both sessions get only Dazza's MCP server (`--strict-mcp-config` on Claude Code). Your personal MCP servers aren't exposed to them.

## Why each task gets its own branch and worktree

Every task is built on its own branch, `dazza/<id>-<slug>`, in its own worktree: a separate checkout under `~/.local/share/dazza/worktrees/`. The agent runs there, not in your project directory, and its work is committed there when it's submitted. Your checkout is never switched or written to while it builds, so your uncommitted work stays out of the agent's commits, and the agent's changes stay out of yours.

Nothing reaches your branch until you approve the task. Approval merges it in (a fast-forward when possible), never over your uncommitted changes, and nothing is ever force-pushed or rewritten. If the merge would conflict, nothing moves and Dazza tells you.

A worktree limits where the agent works, not what it can reach. The agent runs as you, with your permissions, so it could still read or write files outside its worktree. Treat it as a separation of work, not a sandbox.

## The board is local only

The board server binds to `127.0.0.1`, never to a public interface. The API also:

- rejects requests whose `Host` isn't `localhost` or `127.0.0.1`, which blocks DNS rebinding;
- requires a custom header on every write. Browsers won't send it cross-site without a CORS preflight, and the board never grants one, so another site you visit can't approve or close tasks;
- serves screenshots only through paths that match the media path format, so nothing outside `.dazza/media/` is reachable.

The board has no login. Anything that runs as you on your machine can use it.

## Messaging

Messaging lets someone who holds your phone, or your Slack account, drive Dazza. It's worth knowing exactly who it listens to.

- **Telegram** accepts messages only from the chat id linked during setup. Messages from anyone else who finds the bot are ignored. Dazza uses long polling, so there's no webhook and no inbound port.
- **Slack** accepts messages, button clicks, modal submissions and `/dazza` commands only from the Slack user linked during setup. Anyone else who messages the app gets a one-line refusal, and nothing reaches Dazza. It uses Socket Mode: Dazza opens an outbound WebSocket to Slack, so there's no public URL and no inbound port. The app asks for the scopes it uses and no more: `chat:write`, `im:history`, `files:write`, `reactions:write`, `commands` and `users:read` (to look up its own app id during setup). It can't read channels, only its own DM.

A message from the linked account is treated exactly like one typed into the terminal. It can approve and merge work, change the plan, and start a build.

## What leaves your machine

| To | What |
|---|---|
| Anthropic or OpenAI, through the agent CLI | Prompts, project state snapshots, the code the agent reads, and tool output. This is the same as using Claude Code or Codex directly |
| Telegram (if linked) | Notifications, replies, task summaries and screenshots |
| Slack (if linked) | The same as Telegram, plus the project status shown on the app's Home tab |

Dazza itself has no server and no telemetry. It sends nothing anywhere else.

## Reporting a vulnerability

Please report security issues privately through GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Don't open a public issue. Include steps to reproduce, and what an attacker would need (for example, local access or a message to the bot). You'll get a reply as soon as possible.
