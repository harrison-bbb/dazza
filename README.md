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

Just type to talk to Dazza. Slash commands (Tab completes them):

| Command | What it does |
|---|---|
| `/dashboard` | Open the project board in your browser |
| `/status` | Where the project is at |
| `/approve` | Approve the drafted plan |
| `/model [name or number]` | List the models your account can use, or switch |
| `/usage` | Your plan's rate limits and what Dazza has used on this project |
| `/logout` | Sign out of the coding agent's CLI (asks you to confirm) |
| `/help`, `/exit` | |

While Dazza runs, a project board is served at `http://localhost:4777`: a dashboard, the scope document, the task list, and a page for every task and subtask with a comment thread shared with Dazza. It opens when your first plan is ready and updates live. Tasks move through backlog → planned → building → in review (or blocked). Only you close or cancel them, so nothing is done until you say so. Run `dazza board` to open it without starting a chat.

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
