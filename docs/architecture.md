# Architecture

Dazza is a manager, not a coder. It runs the `claude` or `codex` CLI the user already has, headless, and keeps the plan, the board and the conversation in one place. It never edits code itself.

## The shape of it

```
            terminal chat            Telegram / Slack
                  │                        │
                  └──────────┬─────────────┘
                             ▼
                      ChatSession (src/chat)
                    ┌────────┴─────────┐
                    ▼                  ▼
              Manager session     Builder loop
             (one per project)   (one task at a time)
                    │                  │
                    ▼                  ▼
              claude / codex     claude / codex
              read-only tools    auto mode, task branch
                    │                  │
                    └──── dazza mcp ───┘   stdio MCP server, spawned by the agent CLI
                             │
                             ▼
                     .dazza/ (files)  ◀── board (hono, SSE) at localhost:4777
```

Everything the user sees (the terminal, the board, messaging) is a view over the files in `.dazza/`. Agents change those files only through Dazza's MCP tools, which validate every write.

## Principles

1. **Orchestrate, don't code.** All coding goes to the agent CLI. Dazza supplies the prompt, the tools and the rules. Sign-in belongs to the user's own CLI install. An API key is passed through as an environment variable.
2. **State is plain files.** No database. Everything is zod-validated on read and write, and written atomically (temp file, then rename). Read-modify-write goes through a lock file, because several processes touch the same files: the chat, the builder, and each agent's MCP server.
3. **A typed protocol, not prose parsing.** Agents report progress, ask questions and hand work over by calling MCP tools. Dazza doesn't scrape their text for intent.
4. **Nothing is done until the user says so.** Dazza moves tasks to review or blocked. Only the user closes or cancels them.

## Module map

| Path | Job |
|---|---|
| `src/cli/` | Entry point (`dazza`, `dazza doctor`, `dazza board`, hidden `dazza mcp`) |
| `src/chat/` | Terminal UI: line editor, slash commands, status lines, the chat session that runs the manager and the builder side by side |
| `src/core/schema.ts` | zod schemas for the plan, tasks, subtasks, handoffs and events. Types are inferred from these |
| `src/core/store.ts` | Reads and writes `.dazza/` |
| `src/core/config.ts` | Per-user config in `~/.config/dazza` |
| `src/core/manager.ts` | The conversation with the user, as one resumable agent session |
| `src/core/builder.ts` | The build loop: next task, run the worker, handle failures |
| `src/core/work.ts` | Task lifecycle on disk and in git: start, block, submit, pause, land |
| `src/core/actions.ts` | What the user can do (approve, close, request changes, cancel, move). The terminal, board and messaging all call these |
| `src/mcp/` | The stdio MCP server agents use to talk to Dazza |
| `src/providers/` | The `AgentProvider` interface and the Claude Code and Codex adapters. See [providers.md](providers.md) |
| `src/git/` | A thin wrapper over the git CLI |
| `src/board/` | The local board server: JSON API, SSE, static files |
| `web/` | The board UI (React, Vite, Tailwind), built into `dist/web` |
| `src/preview/` | Starts the user's app and takes screenshots with their installed Chrome |
| `src/notify/` | What a notification says, and the `Channel` interface Slack and Telegram implement |
| `src/slack/` | Slack: Web API client, Socket Mode connection, Block Kit views, the bridge, the app manifest |
| `src/telegram/` | Telegram: Bot API client and the bridge |
| `src/setup/` | Onboarding: connecting an agent, linking Slack or Telegram |
| `src/prompts/` | System prompts for the manager and the worker, as Markdown |

## Project state: `.dazza/`

| File | What it holds |
|---|---|
| `scope.md` | The agreed scope of work, in prose |
| `tasks.json` | The plan: tasks, subtasks, acceptance criteria, status, handoffs |
| `events.jsonl` | Append-only activity log: comments, status changes, approvals. Feeds the board and the agents |
| `media/` | Screenshots, e.g. `media/T3/login-desktop.png` |
| `session.json` | The manager's agent session id, so the conversation resumes |
| `build.json` | Per-task build bookkeeping: branch, base branch, start commit, worker session id |
| `usage.json` | Running token and cost totals for the project |
| `*.lock` | Lock files for read-modify-write |

The whole folder is kept out of the project's git history. Dazza adds `.dazza/` to `.git/info/exclude` (local to the machine, nothing committed), and refuses to build if the folder is tracked. The reason is that task branches are checked out in the working directory: if the plan were committed, switching branches would rewind it.

## Two agent sessions

**The manager** is the conversation. Every user message, from the terminal or from messaging, resumes the same agent session and carries a fresh `<project-state>` snapshot (plan status, recent comments), because the board and the builder change things between messages. The manager can read the codebase (`Read`, `Glob`, `Grep`) and use Dazza's manager tools. It has no tools that edit code. On Codex it runs in a read-only sandbox.

**The worker** builds one task. It runs in auto mode (see [security.md](security.md)) with the worker tools, and gets a brief made from the scope, the task, its acceptance criteria and the comments so far.

Both run through the same `AgentProvider` interface, so neither cares whether Claude Code or Codex is underneath.

## The MCP server

Each agent CLI spawns `dazza mcp --root <project> --role manager|worker` over stdio. The server name is `dazza`, so tools appear to agents as `mcp__dazza__<name>`. Each role only gets its own tools, and the agent CLI is told to use only Dazza's MCP server (`--strict-mcp-config` on Claude Code), not the user's personal ones.

| Tool | Role | What it does |
|---|---|---|
| `save_plan` | manager | Save the scope and tasks. Revising an approved plan sends it back to draft for re-approval |
| `update_item` | manager | Edit a task or subtask's title or description |
| `add_task`, `add_subtask` | manager | Add work the user asked for |
| `set_status` | manager | Close, cancel or move a task when the user says so. Same rules as the board |
| `comment` | both | Post on a task's thread or the project, optionally with screenshots |
| `screenshot` | both | Capture the running app |
| `update_subtask` | worker | Mark a subtask started or finished |
| `check_messages` | worker | Pick up comments the user left since the last check |
| `block` | worker | Ask the user one question, and stop |
| `submit` | worker | Hand the task over for review. Dazza commits the work |

Tool input is validated with zod. Invalid input comes back to the agent as a tool error so it can correct itself. Worker tool results also carry any new comments from the user, so instructions reach a running build at its next tool call.

## The build loop

`/build` runs `build()` in `src/core/builder.ts` in the background while the chat stays usable.

1. **Prepare the repo.** Create one if there isn't one. Refuse to start with uncommitted changes, so the user's work and Dazza's stay separate.
2. **Pick the next task** whose dependencies are met (`nextTask` in `src/core/plan.ts`).
3. **Check out its branch**, `dazza/<id>-<slug>`, from the current commit. Tasks are stacked: each one starts where the previous one ended. There are no worktrees; the build happens in the project directory.
4. **Run the worker** until it calls `submit` (task goes to review) or `block` (task goes to blocked, with the question). Blocked work doesn't stall the build. The loop moves to the next ready task.
5. **Stop** when nothing is ready, the user has to act, or the user stops it. A stopped task is paused and resumes its agent session next time.

**Landing.** Approving a task fast-forwards the base branch (the branch the user was on) to the task's commit. Because tasks are stacked, a task only lands once everything it was built on is there: approving T4 before T3 waits for T3, and approving T3 then lands both. If histories have diverged, nothing moves. Requesting changes sends the task back to planned with the user's note, and the next build picks it up on the same branch.

## Resilience

Builds are meant to run unattended, so the loop handles the common failures (`DEFAULT_TIMING` in `builder.ts`):

| Failure | What happens |
|---|---|
| Usage limit on a subscription | Pause, report the reset time, sleep until it passes (plus a minute), resume the same session |
| Out of credit, or a rejected key | Stop immediately. The adapters kill the CLI rather than let it retry something retries can't fix |
| Service overloaded | Back off (1, 2, 3 minutes) and retry, up to three times |
| Agent CLI crashes | Retry once, resuming the session. A second crash blocks the task with the error |
| No output for 20 minutes | Stop the worker and block the task with an explanation |

Errors are classified from the CLI's own messages and status codes in `src/providers/errors.ts`.

## The board

`src/board/server.ts` is a small hono app bound to `127.0.0.1`, on the first free port from 4777. It serves the built React app and a JSON API over the same store and actions the terminal uses. Live updates use server-sent events: the server polls `tasks.json`, `scope.md` and `events.jsonl` with `fs.watchFile`, so changes from any process (the chat, an agent's MCP server, a hand edit) reach open tabs. See [security.md](security.md) for how it stays local.

## Screenshots

`src/preview/` starts the user's app if it isn't running (a `dev`, `start` or `preview` script, or plain HTML served by a tiny static server), then drives the user's installed Chrome, Chromium or Edge with `playwright-core`. Nothing is downloaded. Captures are desktop (1280x800) or phone sized, at 2x density, and stored under `.dazza/media/`. Agents take them through the `screenshot` tool, and attach them to comments, questions or handoffs.

## Messaging

Messaging is the same conversation as the terminal, from a phone. Messages go to the manager session, and replies go back where the message came from. Build events (ready for review, blocked, usage limit, build stopped) and screenshots Dazza shares are sent out as notifications.

`src/notify/notification.ts` decides *what* to say about a build event, as structured data. Each channel implements `Channel` (`src/notify/channel.ts`) and decides *how* to say it: plain text on Telegram, Block Kit on Slack. The chat loop in `src/chat/repl.ts` fans notifications out to every linked channel. Button clicks go through the same `src/core/actions.ts` functions as the terminal and the board, so the rules live in one place.

**Telegram** (`src/telegram/`) uses the Bot API over plain `fetch` with long polling, so no public URL is needed. It only accepts messages from the linked chat. `/status`, `/build` and `/stop` work there too. If another Dazza window is already polling the same bot, Telegram rejects the second poller, and Dazza says so.

**Slack** (`src/slack/`) uses the Web API over plain `fetch` and Socket Mode over Node's built-in `WebSocket`, so there are no new dependencies, no public URL and no inbound port.

- **Setup** opens Slack's "create app" page with a manifest filled in (`manifest.ts`: scopes, events, Socket Mode, `/dazza`). The user installs it and pastes two tokens: the bot token (to post) and an app-level token (to receive). Dazza then waits for the user's first DM to the bot. Whoever sends it is the linked user, and that DM is where Dazza talks.
- **The DM** is the conversation. Dazza reacts with 👀 while it works out an answer, then swaps it for ✅ once it has replied. Replying in the thread under a notification tells the manager which task it's about ("About T5: …"), and the answer goes back into that thread.
- **Review notifications** have Approve (with a confirm, since it merges) and Request changes (a modal asking what to change) buttons. Once used, the buttons are replaced by the outcome, so a stale button can't be pressed twice. Screenshots go in the notification's thread.
- **The Home tab** shows progress, what needs the user (with the same buttons), and every task. It's republished when the build starts or stops, after actions, and whenever the user opens it. When Dazza exits it shows "Dazza isn't running", with no buttons.
- **`/dazza status|build|stop`** works from any channel, and answers only the user who typed it.
- **One window at a time.** Slack spreads Socket Mode events across all open connections at random, so a second Dazza window would get some of the user's messages for the wrong project. The first window to start claims `~/.config/dazza/slack.lock` (keyed by process id, so a crashed window's claim is taken over). Other windows still send notifications, but don't listen.

## Design choices worth defending

- **No database.** The state is small, and files let the user read, diff and fix it. The cost is locking, which `src/util/lock.ts` covers with a lock file and stale-lock recovery.
- **Stream JSON, not a library SDK.** Driving the CLIs keeps auth and billing with the user's own install and plan. Each adapter translates its CLI's stream into one provider-neutral event type. Unknown lines are ignored, so a new CLI version doesn't break the parser.
- **Branches, not worktrees.** One task builds at a time, so one working directory is enough, and the user can check out any task branch to try it. The price is that the tree has to be clean before a build starts.
