# dazza

> Stop operating your coding agent. Start managing it.

Dazza turns [Claude Code](https://docs.claude.com/en/docs/claude-code) or [Codex](https://github.com/openai/codex) into a contractor you manage, instead of a tool you operate. You describe what you want. Dazza scopes it into a plan you approve, builds it task by task on its own branches, and hands each piece over for review with evidence that it works. It asks before anything risky and only interrupts you when it needs a decision. You can run it from your terminal, a local board, or your phone.

> **Status:** early development, built in public. Expect rough edges, and please file issues.

## What a project looks like

```
› I want a booking app for my dog-walking business

● Nice. A few questions first:
  1. Who books: just clients, or do you assign walkers too?
  …

● Got enough to go on. Writing up the plan now, a few minutes.
✔ Plan saved · 9 tasks · about 5½ hours of building
  M1 Bookings · Clients can request walks and you approve them
    T1  Project setup · S
    T2  Client sign-up and dogs · M
    …
  Review it at http://localhost:4777 · approve there, here, or with /approve

› looks good, approve it. /build

● Building T1 · Project setup
  on branch dazza/T1-project-setup · usually ~20 minutes · towards M1 Bookings · /stop to stop
  …
● T1 is ready for your review · all 4 criteria met · 6 files changed · 12 checks passed
  /accept T1 to merge it · /changes T1 <what to change> · /try T1 to run it first
```

1. **Scoping is a conversation.** Dazza reads your code first if there is any, asks a few questions at a time, and makes sensible calls on anything you don't care about. It asks what's live (real users, data or money) before planning.
2. **The plan is a real spec.** It has a scope document (users, flows, data model, what's in and out, decisions, risks, guardrails) and tasks with clear descriptions, subtasks, checkable acceptance criteria and a size. Bigger plans are grouped into milestones, each a stage you can actually try. It all shows on a local board.
3. **Building happens beside you, not over you.** Each task is built in its own git worktree, on its own branch, so your checkout is never touched. Keep working, uncommitted changes and all.
4. **Every handoff comes with proof.** The builder reports on each acceptance criterion with evidence: the test, the command and what it showed. Dazza won't accept a handoff that contains secrets or files that shouldn't be committed. You review, then `/accept` to merge or `/changes` to send it back.
5. **You're only interrupted for real decisions.** Blocked tasks ask one clear question and the build moves on. Answer from anywhere, and it picks the task back up.
6. **Milestones and a close-out.** When a stage is done, Dazza tells you what it delivered. At the end, it writes a report: what was built, what changed along the way, how to run it, and what's next.

## Get started

You need Node 22+ and [Claude Code](https://docs.claude.com/en/docs/claude-code) or [Codex](https://github.com/openai/codex) installed and signed in.

```sh
git clone https://github.com/harrison-bbb/dazza && cd dazza
pnpm install && pnpm build && npm link

cd ~/your-project
dazza doctor   # checks everything's ready
dazza          # start talking
```

The first run asks how Dazza should reach the AI, then offers to link Slack or Telegram:

| Connection | Agent | Pays through |
|---|---|---|
| Claude subscription | Claude Code | your Pro or Max plan |
| Anthropic API key | Claude Code | pay as you go |
| ChatGPT subscription | Codex | your Plus or Pro plan |
| OpenAI API key | Codex | pay as you go |

On a subscription, Dazza uses the agent CLI's own sign-in. It strips any API key or other billing setting in your shell from the agent's environment, so billing can't quietly switch.

## Commands

Just type to talk to Dazza, about anything in the project. Type `/` for commands; they're instant and cost nothing.

| The work | |
|---|---|
| `/build` | Build the approved plan, task by task, showing the work as it happens |
| `/stop` | Stop building. The current task picks up where it left off |
| `/status` | Where the project is at |
| `/tasks` | Every task, by milestone, with status and size |
| `/next T7` | Build T7 next (it still waits for what it depends on) |

| Reviewing | |
|---|---|
| `/review` | Everything waiting on you, and what to do about each |
| `/accept T3` | Approve T3; it merges into your branch |
| `/changes T3 <note>` | Send T3 back with what to change |
| `/try T3` | Where to run T3's work before approving it |
| `/diff T3` | What T3 changed, file by file |
| `/allow T3`, `/deny T3` | Answer T3's request to run a command that needs your OK |
| `/cancel T5` | Drop a task (asks you to confirm first) |

| The project | |
|---|---|
| `/approve` | Approve the drafted plan |
| `/dashboard`, `/scope` | Open the board, or the scope document |
| `/report` | A progress report, or the close-out at the end |
| `/new` | Start a fresh conversation. The plan and board stay as they are |

| Setup | |
|---|---|
| `/model`, `/usage` | Switch models; see your plan's limits or API spend |
| `/slack`, `/telegram` | Connect (or check) Slack or Telegram. `-disconnect` to unlink |
| `/logout`, `/help`, `/exit` | |

The board runs at `http://localhost:4777` while Dazza is open. It has the dashboard, milestones, the scope and its change log, every task with its handoff and evidence, and comment threads shared with Dazza. `dazza board` opens it without starting a chat.

## Safe to point at real work

Dazza's builder works like a careful engineer on someone else's systems. On Claude Code, every command and file access goes through **Dazza's guard** before it runs:

- **Never, even if asked:** pushing, deploying or publishing, `sudo`, credential files, anything outside the task's worktree, switching branches, changing cloud or cluster resources.
- **Asks you first:** remote databases, deleting data, sending changes to outside services, machine-wide installs. The builder asks with the exact command and why. You answer with `/allow`, `/deny`, the board, or a button on your phone. Allowing covers that one command for that one task.
- **Just works:** everything else inside the task's worktree.

Before any handoff is committed, Dazza checks it the way a reviewer would: no secrets (live keys, private keys, tokens), no `.env` files, logs or `node_modules`, and nothing enormous. Background processes the builder started (say, a dev server) are stopped when its run ends. Everything the guard stops is logged on the task. [docs/security.md](docs/security.md) has the full rules, and their limits.

## Plans change

Ask "can we do X instead?", "add Y", or "we don't need T9", and Dazza handles it like a good contractor handles a change request. It proposes first: which tasks it adds, changes or cancels, what already-built work it touches, and what it costs in time. Nothing changes until you say yes, and cancelling always gets a confirm. Then the tasks and the scope document are updated together, and the scope's change log records the new version, what changed, and why. Small edits ("rename T3", "do T7 next") just happen.

## Away from your desk

Link **Slack** or **Telegram** and Dazza reaches you while it builds. It's the same conversation as the terminal.

- **Notifications:** a task ready for review (with screenshots and the criteria results), a blocked task's question, a command waiting for your OK, a milestone reached, a build that stopped, a usage limit.
- **Buttons:** Approve (with a confirm), Request changes, Allow once / Don't allow.
- **Threads:** reply to a notification and Dazza knows which task you mean.
- **Slack extras:** a Home tab with the whole project, and `/dazza status|build|stop` from anywhere. Setup takes about two minutes, with no server; it uses Socket Mode.

Only you are listened to. Messages from anyone else are ignored.

## When things go wrong

- **Usage limit reached:** the task pauses and resumes the same session when the limit resets.
- **Out of credit, or a rejected key:** it stops straight away and says what to do.
- **Overloaded service:** it backs off and retries. **The agent CLI crashes:** it retries once, then blocks the task with the error.
- **Dazza is killed** (terminal closed, laptop died): the task resumes in its worktree next time.
- **Lost conversation** (Claude Code deletes old sessions): it starts a fresh one, and the plan is unaffected.
- **A stuck builder** (20 minutes of silence): it stops it, explains, and moves on.

## How it works

```
you ──chat, board, phone──▶ dazza (manager session) ──▶ .dazza/ scope, tasks, events
                                │
                                └─ build loop ──▶ claude / codex, headless, one worktree per task
                                                     │  every tool call through Dazza's guard
                                                     └─ handoff ──▶ review ──▶ merge on approval
```

- **No new coding brain.** Dazza orchestrates the agent CLI you already use, with your login.
- **Plain files.** Project state is readable files in `.dazza/`, kept out of git.
- **Typed protocol.** Agents talk to Dazza through its MCP tools, not by parsing prose.

More in [docs/architecture.md](docs/architecture.md), [docs/providers.md](docs/providers.md) and [docs/security.md](docs/security.md).

## Limits

- Dazza builds one task at a time, and only while it's open.
- The guard is strongest on Claude Code. On Codex, the agent's own sandbox applies but Dazza's command rules don't.
- Task sizes are estimates. The close-out report compares them with how long tasks actually took.
- Deploying is deliberately yours: Dazza prepares the config and a checklist, and you do the final steps.

## Development

```sh
pnpm install
pnpm check   # lint + typecheck + tests
pnpm build && node dist/cli.js
```

Tests use recorded agent output and fake CLIs, never live model calls. For board work with hot reload, run `dazza board` in a project with a plan, then `pnpm dev:web`. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
