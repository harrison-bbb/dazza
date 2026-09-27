# dazza

> Stop operating your coding agent. Start managing it.

Dazza is a harness around [Claude Code](https://docs.claude.com/en/docs/claude-code) and
[Codex](https://github.com/openai/codex) that moves you from the operator's seat to the manager's.
You talk through what you want to build. Dazza scopes it into tasks with clear acceptance criteria and
shows you the plan on a local board. Once you approve it, Dazza works through the tasks like a
contractor. It reports progress over Telegram, sends a handoff with screenshots when a milestone is
done, and only interrupts you when it actually needs something.

> **Status:** early development. This is being built in public over 30 days.

## How it works

```
you ──chat──▶ dazza ──scopes──▶ .dazza/ (scope + tasks) ──▶ localhost board (approve)
                 │
                 └─works──▶ claude / codex (headless, one git branch per task)
                              │
                              └─reports──▶ Telegram (handoffs, blockers, scope changes)
```

- **No new coding brain.** Dazza orchestrates the `claude` or `codex` CLI you already use, with your existing login.
- **Plain-file state.** Everything lives in `.dazza/` in your repo. You can read it, diff it and commit it.
- **Safe by default.** Each task gets its own branch. Nothing merges until you approve it.

## Try it

Dazza needs [Claude Code](https://docs.claude.com/en/docs/claude-code) installed and signed in.

```sh
pnpm install && pnpm build && npm link
cd ~/some-project
dazza doctor   # check everything's ready
dazza          # start talking
```

The first time you run it, Dazza asks how to connect: your Claude subscription (through your Claude Code sign-in) or an Anthropic API key.

Just type to talk to Dazza. Type `/` for commands:

| Command | What it does |
|---|---|
| `/build` | Build the approved plan, task by task, showing the work as it happens |
| `/dashboard` | Open the project board in your browser |
| `/status` | Where the project is at |
| `/approve` | Approve the drafted plan |
| `/model [name or number]` | List the models your account can use, or switch |
| `/usage` | Session and weekly limits on a subscription, or dollars spent on an API key |
| `/telegram` | See your Telegram link, or connect Telegram |
| `/telegram-disconnect` | Unlink your bot and link a new one |
| `/logout` | Sign out of Dazza; your Claude Code sign-in is untouched |
| `/help`, `/exit` | |

While Dazza runs, a project board is served at `http://localhost:4777`: a dashboard, the scope document, the task list, and a page for every task and subtask with a comment thread shared with Dazza. It opens when your first plan is ready and updates live. Tasks move through backlog → planned → building → in review (or blocked). Only you close or cancel them, so nothing is done until you say so. Run `dazza board` to open it without starting a chat.

### Building

`/build` works through the plan in dependency order. Each task is built on its own branch (`dazza/T3-…`) by Claude Code in [auto mode](https://docs.claude.com/en/docs/claude-code), which runs edits and commands without asking while its safety checks block risky actions. You see the narration, every edit (with a short diff) and every command as they happen. When a task is done Dazza commits it and moves it to **in review**. If Claude needs a decision or a credential, the task goes to **blocked** with the question, and Dazza moves on to the next task. Approving a task merges it into your branch, in order. Requesting changes sends it back, and the next `/build` picks it up with your note. Ctrl-C stops cleanly, and the task resumes next time.

While it builds you can keep talking to Dazza in the terminal. Comments you leave on the board, or instructions you give in the chat, reach the build at its next check-in.

### Telegram

Onboarding offers to link a Telegram bot (or run `/telegram` later). Create a bot with [@BotFather](https://t.me/BotFather), paste its token, and message the bot once so Dazza can find your chat. While Dazza is open it messages you when a task is ready for review or blocked, and when a build finishes. You can reply from your phone: it's the same conversation as the terminal. `/status`, `/build` and `/stop` also work there. Dazza only accepts messages from your own chat.

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
