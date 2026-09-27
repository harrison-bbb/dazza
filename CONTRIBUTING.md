# Contributing

Thanks for looking. Dazza is small on purpose. Changes that keep it that way are the easiest to merge.

## Setup

You need Node 22 and pnpm.

```sh
pnpm install
pnpm check   # lint + typecheck + test
pnpm build
```

To try your build as the real `dazza` command:

```sh
pnpm build && npm link
cd ~/some-project
dazza doctor
dazza
```

For board UI work with hot reload, run `dazza board` in a project with a plan, then `pnpm dev:web`.

Read [docs/architecture.md](docs/architecture.md) first. It covers how the pieces fit and why.

## Tests

- Every module has unit tests in `test/`, mirroring `src/`.
- Tests never call a live model or a real messaging API. Provider tests run the adapters against fake CLIs in `test/fixtures/bin/` (`fake-claude.mjs`, `fake-codex.mjs`), which replay recorded streams from `test/fixtures/claude/` and `test/fixtures/codex/`. HTTP clients take a `fetch` implementation, so tests pass a fake one.
- If you change how an adapter parses output, record the real CLI output you're handling and add it as a fixture.
- `useTempProject()` in `test/helpers.ts` gives each test a fresh project directory, store and config.

`pnpm check` must pass. CI runs lint, typecheck, test and build on every pull request.

## Code style

- Strict TypeScript, no `any`. Types come from zod schemas (`z.infer`), and nothing is declared twice.
- Small modules with one job each. Put the rules in one place: user actions go through `src/core/actions.ts`, so the terminal, the board and messaging all behave the same.
- No abstraction before there's a second user of it.
- Prompts live in `src/prompts/*.md`, not in strings in the code.
- Comments explain why, not what.
- User-facing text is plain and short. Say what happened and what to do next.
- Biome handles formatting and lint: `pnpm format` fixes most things.

## Commits and pull requests

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`. Keep each pull request to one change, and say in the description how you checked it works, not just that the tests pass.

Security issues: see [docs/security.md](docs/security.md#reporting-a-vulnerability). Please don't open a public issue.
