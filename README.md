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

Just type to talk to Dazza. `/status`, `/approve` and `/help` are shortcuts.

## Development

Requires Node 22 and pnpm.

```sh
pnpm install
pnpm check   # lint + typecheck + test
pnpm build && node dist/cli.js
```

## License

[MIT](LICENSE)
