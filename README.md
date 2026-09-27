# dazza

> Stop operating your coding agent. Start managing it.

Dazza is a harness around [Claude Code](https://docs.claude.com/en/docs/claude-code) or
[Codex](https://github.com/openai/codex) that moves you from the operator's seat to the manager's.
You talk through what you want to build. Dazza scopes it into tasks with clear acceptance criteria and
shows you the plan on a local board. Once you approve it, Dazza works through the tasks like a
contractor. It reports progress over Slack or Telegram, sends a handoff with screenshots when a milestone is
done, and only interrupts you when it actually needs something.

> **Status:** early development. This is being built in public over 30 days.

## How it works

```
you ──chat──▶ dazza ──scopes──▶ .dazza/ (scope + tasks) ──▶ localhost board (approve)
                 │
                 └─works──▶ claude / codex (headless, one git worktree per task)
                              │
                              └─reports──▶ Slack / Telegram (handoffs, blockers, approvals)
```

- **No new coding brain.** Dazza orchestrates the `claude` or `codex` CLI you already use, with your existing login.
- **Plain-file state.** Everything lives in `.dazza/` in your repo. You can read it, diff it and commit it.
- **Safe by default.** Each task is built in its own worktree, on its own branch, so your checkout is never touched. Nothing merges until you approve it.

## Try it

You need Node 22 or later. Dazza drives [Claude Code](https://docs.claude.com/en/docs/claude-code) or [Codex](https://github.com/openai/codex), whichever you use. Install at least one. The first run asks how to connect:

| Connection | Agent | Pays through |
|---|---|---|
| Claude subscription | Claude Code | your Pro or Max plan |
| Anthropic API key | Claude Code | pay as you go |
| ChatGPT subscription | Codex | your Plus or Pro plan |
| OpenAI API key | Codex | pay as you go |

On a subscription, Dazza uses the agent CLI's own sign-in, and strips stray API keys from its environment so billing can't switch without you knowing.

```sh
pnpm install && pnpm build && npm link
cd ~/some-project
dazza doctor   # check everything's ready
dazza          # start talking
```

The first time you run it, Dazza asks which of those four to use, then offers to link Slack or Telegram so it can reach you when you're away.

Just type to talk to Dazza. Type `/` for commands:

| Command | What it does |
|---|---|
| `/build` | Build the approved plan, task by task, showing the work as it happens |
| `/dashboard` | Open the project board in your browser |
| `/status` | Where the project is at |
| `/approve` | Approve the drafted plan |
| `/model [name or number]` | List the models your account can use, or switch |
| `/usage` | Session and weekly limits on a subscription (live on Codex), or spend on an API key |
| `/slack` | See your Slack link, or connect Slack |
| `/slack-disconnect` | Unlink Slack, then link it again if you like |
| `/telegram` | See your Telegram link, or connect Telegram |
| `/telegram-disconnect` | Unlink your bot and link a new one |
| `/new` | Start a fresh conversation; the plan and board stay as they are |
| `/logout` | Sign out of Dazza; your Claude Code or Codex sign-in is untouched |
| `/help`, `/exit` | |

While Dazza runs, a project board is served at `http://localhost:4777`: a dashboard, the scope document, the task list, and a page for every task and subtask with a comment thread shared with Dazza. It opens when your first plan is ready and updates live. Tasks move through backlog → planned → building → in review (or blocked). Only you close or cancel them, so nothing is done until you say so. Run `dazza board` to open it without starting a chat.

### Building

`/build` works through the plan in dependency order. Each task is built on its own branch (`dazza/T3-…`), in its own checkout (a git worktree) so yours is never touched, by Claude Code in [auto mode](https://docs.claude.com/en/docs/claude-code), which runs edits and commands without asking while its safety checks block risky actions. You see the narration, every edit (with a short diff) and every command as they happen. When a task is done Dazza commits it and moves it to **in review**. If Claude needs a decision or a credential, the task goes to **blocked** with the question, and Dazza moves on to the next task. Keep working while it builds, uncommitted changes and all. To try a task before approving it, `cd` into its worktree (the review shows where). Approving a task merges it into your branch, in dependency order; if it can't (it conflicts, or you have uncommitted changes on that branch), Dazza says so and tries again next build. Requesting changes sends it back, and the next `/build` picks it up with your note. Ctrl-C stops cleanly, and the task resumes next time.

While it builds you can keep talking to Dazza in the terminal. Comments you leave on the board, or instructions you give in the chat, reach the build at its next check-in.

### When things go wrong

Builds are meant to run while you're away, so Dazza handles the usual failures itself:

- **Usage limit reached** (subscription): Dazza pauses the task and messages you with the reset time. When the limit lifts, it picks up the same session, as long as Dazza is still open.
- **Out of API credit, or a rejected key:** Dazza stops straight away, instead of letting Claude Code retry for minutes, and tells you what to do.
- **Anthropic overloaded:** Dazza backs off and retries.
- **Claude Code crashes:** Dazza retries once. If it crashes again, the task is blocked with the error.
- **Dazza itself is killed** (terminal closed, laptop died): next time, the task goes back in the queue and resumes in its worktree, where its work was left.
- **A stuck worker** (20 minutes of complete silence): Dazza stops it, blocks the task with an explanation, and moves on.

### Screenshots

Dazza takes screenshots when a picture helps, not for everything:
- when you ask for one;
- when it wants your opinion on UI it's building;
- when it finishes UI work (they go in the handoff);
- when it spots a visual problem.

It starts your app if it isn't running (your `dev`, `start` or `preview` script, or plain HTML), and captures crisp desktop or phone views with the Chrome you already have. Screenshots show up on the board, and arrive in Slack or Telegram.

### Slack

Onboarding offers to link Slack (or run `/slack` later). Setup takes about two minutes and needs no server: Dazza opens Slack's "create app" page with everything filled in, you install it to your workspace and paste two tokens, then send the app a message so Dazza knows who you are. After that, while Dazza is open:

- **Dazza DMs you** when a task is ready for review or blocked, when a build stops, and when you hit a usage limit. Screenshots go in the thread under each notification.
- **Approve or send work back from Slack.** Review notifications have **Approve** and **Request changes** buttons. Requesting changes asks what to change, and the next build works from your note.
- **Talk to it in the DM**, like the terminal: it’s the same conversation. 👀 means it’s on it, ✅ means it has answered. Reply in a notification's thread and Dazza knows which task you mean.
- **The Home tab** shows the project at a glance: progress, what needs you, and every task, with buttons to start or stop the build.
- **`/dazza status`, `/dazza build` and `/dazza stop`** work from anywhere in Slack.

Dazza only listens to you: messages and clicks from anyone else in the workspace are ignored. It uses Socket Mode, so nothing on your machine is exposed to the internet. If you have Dazza open in two projects, the first one handles your Slack messages. Notifications from both still arrive.

### Telegram

Onboarding also offers to link a Telegram bot (or run `/telegram` later). Create a bot with [@BotFather](https://t.me/BotFather), paste its token, and message the bot once so Dazza can find your chat. While Dazza is open it messages you when a task is ready for review or blocked, and when a build finishes. You can reply from your phone: it's the same conversation as the terminal. `/status`, `/build` and `/stop` also work there. Dazza only accepts messages from your own chat.

You can also run the project from the chat: "close T4", "unblock T5, tags are case-insensitive", "add a subtask to T3 for X", "move T8 to the backlog". Changes you ask for apply straight away and show up on the board.

## Development

Requires Node 22 and pnpm.

```sh
pnpm install
pnpm check   # lint + typecheck + test
pnpm build && node dist/cli.js
```

For board UI work with hot reload, run `dazza board` in a project with a plan, then `pnpm dev:web`.

## License

[MIT](LICENSE)
