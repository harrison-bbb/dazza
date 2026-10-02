# Providers

A provider is a coding agent CLI that Dazza drives headless. There are two: Claude Code (`src/providers/claude.ts`) and Codex (`src/providers/codex.ts`). The rest of Dazza only sees the interface in `src/providers/types.ts`.

## The interface

```ts
interface AgentProvider {
  readonly id: 'claude' | 'codex';
  readonly name: string;
  detect(): Promise<ProviderStatus>;             // installed? signed in? plan?
  run(options: AgentRunOptions): AsyncIterable<AgentEvent>;
  listModels(): Promise<ModelOption[]>;          // must not spend tokens
  readLimits?(): Promise<UsageWindow[] | undefined>;
  signIn(): Promise<void>;                       // hand the terminal to the CLI's own login
}
```

`AgentRunOptions` carries the prompt, working directory, an optional session to resume, a system prompt, a model, the tools allowed without asking, the MCP servers the session may use, and `autonomous` (edit and run commands without asking).

`run` yields provider-neutral `AgentEvent`s:

| Event | Meaning |
|---|---|
| `started` | Session id and model |
| `text` | Something the agent said |
| `tool_use`, `tool_result` | A tool call and whether it worked. Tool names match across providers where it matters (Dazza's MCP tools always do) |
| `retry` | The CLI is retrying a failed API call itself |
| `limits` | Subscription rate-limit windows, and when the account is being refused |
| `finished` | Always last. Success or failure, output, session id, duration, usage, and a classified `AgentError` on failure |

## Connections

A `Connection` (in `~/.config/dazza/connection.json`) is a provider plus a method:

- **subscription**: the CLI's own sign-in. Dazza removes stray API key variables from the child's environment (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK` and `CLAUDE_CODE_USE_VERTEX` for Claude Code, `OPENAI_API_KEY` and `CODEX_API_KEY` for Codex), so billing can't quietly switch to a key in the user's shell.
- **api-key**: Dazza passes the saved key in (`ANTHROPIC_API_KEY` or `CODEX_API_KEY`).

Prompts always go on stdin, never as a command-line argument.

## Claude Code

Headless runs use:

```
claude -p --output-format stream-json --verbose
  [--resume <session>] [--append-system-prompt <prompt>] [--model <id>]
  [--mcp-config <json> --strict-mcp-config]
  [--tools <built-in tools>] [--allowedTools <list>]
  [--permission-mode auto]
```

- `--strict-mcp-config` means the session only gets Dazza's MCP server, not the user's own.
- `--tools` sets which built-in tools the session has at all. Every tool a session has is described in every request, so this is also the biggest saving: the manager gets `Read`, `Glob`, `Grep`, `WebSearch` and `WebFetch` (to check prices, versions and docs while scoping), and builders get what building needs (`Bash`, `Monitor`, `TaskStop`, `Read`, `Edit`, `Write`, `NotebookEdit`, `Glob`, `Grep`, `WebFetch`, `WebSearch`), without subagents or workflows. Tools not listed aren't loaded at all, which roughly halves the context of every turn.
- `--allowedTools` lists what runs without asking. In a non-interactive run, anything else that needs permission is denied. The manager gets `Read`, `Glob`, `Grep` and its Dazza tools.
- The worker adds `--permission-mode auto`: edits and commands go ahead, and Claude Code's own safety checks block risky actions.

`parseClaudeLine` turns each stream-json line into events. `system/init` starts the run, other `system` lines are API retries, `assistant` messages carry text and tool calls, `user` messages carry tool results, `rate_limit_event` lines carry limit windows, and `result` finishes. Unknown lines are dropped. The stream can repeat a tool call, so each call id is reported once. A "rejected" rate-limit reading supplies the reset time when the final error doesn't.

`detect` runs `claude --version` and `claude auth status`. `listModels` sends the CLI an `initialize` control request over stream-json and reads the models from the reply, without starting a conversation. Limits are only known during a run.

## Codex

Headless runs use `codex exec --json --skip-git-repo-check`, with configuration passed as `-c` overrides:

- **Building** (`autonomous`): `--approve-for-me` (the workspace-write sandbox with automatic approval review) and `sandbox_workspace_write.network_access=true`.
- **Conversation**: `-s read-only` and `approval_policy="never"`.
- The system prompt goes in as `developer_instructions`.
- Each MCP server is set with `mcp_servers.<name>.command`, `.args`, and `default_tools_approval_mode="approve"`, so Dazza's tools are pre-approved.
- Dazza's guard is a `hooks.PreToolUse` hook, with `--dangerously-bypass-hook-trust` since Codex otherwise only runs hooks the user has reviewed. Before each guarded run, the adapter asks the app server for `hooks/list` in the run's directory and refuses (a `setup` error) if the project brings untrusted hooks of its own, which that flag would otherwise run too.
- The user's own MCP servers (from `codex mcp list --json`) are switched off with `mcp_servers.<name>.enabled=false`, so a run gets only Dazza's. Codex splits `-c` keys on every dot, even quoted, so a server with a dot in its name can't be switched off: the adapter refuses and says how to fix it.
- `resume <thread>` continues a session. `-` reads the prompt from stdin.

`CodexStream` is stateful: it remembers the thread id and whether the turn finished, and maps Codex items (commands, file changes, MCP calls) onto the same tool events Claude Code produces.

`detect` runs `codex --version`, then reads the account from Codex's app server (JSON-RPC over stdio). `listModels` and `readLimits` use the app server too, for the model list and live plan limits. None of these spend tokens.

## Errors

`classifyError` in `src/providers/errors.ts` sorts a failure into one of:

| Kind | Dazza's response |
|---|---|
| `usage_limit` | Wait for the reset (parsed from the event or from text like "try again at 9:08 PM"), then resume |
| `credits` | Stop and tell the user to top up |
| `auth` | Stop and tell the user to sign in again or reconnect |
| `overloaded` | Back off and retry |
| `failed` | Anything else |

Order matters: "usage credit limit reached" is about credits, not a usage limit. `credits` and `auth` are hopeless: retrying won't fix them. When a CLI starts retrying one of those, the adapter aborts it and finishes the run with the error straight away, instead of waiting minutes for the CLI to give up.

## Model routing with Jev

With Jev connected and model routing on (`/jev`), a builder doesn't always use the model chosen with `/model`. Before a task starts, `taskModel` (`src/jev/taskModel.ts`) asks Jev two questions about it: how capable a model it needs (`fast`, `balanced` or `deep`), and whether it touches money, credentials, auth, production data or anything hard to undo. `routeModel` (`src/jev/routing.ts`) then picks:

- **The model chosen with `/model` is the ceiling.** Routing only steps down from it.
- **It steps down only when it's safe to.** A task moves to a cheaper tier only if Jev puts the chance it needs more than that tier at 25% or less. Jev's probabilities are calibrated, so that's a real one-in-four.
- **Risky tasks keep the ceiling.**
- **Tiers come from the model family.** Haiku is `fast`, Sonnet `balanced`, Opus and Fable `deep`. On Codex, models named mini, nano, lite, flash or spark are `fast`. A model Dazza can't place is never routed to, and only models that can build on their own are picked.
- **Work sent back twice gets a tier more.** That's twice by you or by the scope check.

The choice is kept in the task's build record (`route` in `.dazza/build.json`), so a resumed session keeps its model, and it's shown on the task's timeline as a `routed` event. If Jev fails, the model list can't be read, or routing is off, the task builds with the `/model` choice as before.

Jev is called through one of three providers (`src/jev/providers.ts`). All three speak TypeSafe's System One API (`POST <base>/v1/systemone`), so only the address and the model's name differ:

| Provider | Base URL | Model |
|---|---|---|
| TypeSafe | `https://api.typesafe.ai` | `jev-latest` |
| OpenRouter | `https://openrouter.ai/api` | `jev-1.13` |
| Vercel AI Gateway | `https://ai-gateway.vercel.sh/typesafe` | `typesafe-ai/jev` |

## Adding a provider

1. Implement `AgentProvider` in `src/providers/<name>.ts`. Keep argument building (`build<Name>Args`) and stream parsing as exported pure functions so they can be tested without spawning anything.
2. Map the CLI's stream onto `AgentEvent`. Ignore lines you don't recognise. Always end a run with exactly one `finished`, and classify failures with `classifyError`.
3. Respect `allowedTools`, `mcpServers` and `autonomous`. The manager must not be able to edit code. If the CLI can't restrict tools, use its read-only mode for non-autonomous runs, as the Codex adapter does.
4. Strip the provider's API key variables on subscriptions, and pass the saved key on API-key connections.
5. Add the id to `ProviderId`, wire it into `createProvider`, `providerFor` and `PROVIDER_HELP` in `src/providers/index.ts`, and add it to the connect flow in `src/setup/connect.ts`.
6. Record real output as fixtures in `test/fixtures/<name>/`, and add a fake CLI in `test/fixtures/bin/` that replays them. Tests never call a live model.
