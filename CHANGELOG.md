# Changelog

## Unreleased

- **`/jev`: the right model for each task, and work checked against its scope.** Connect Jev, TypeSafe's classifier, with your own key through TypeSafe, OpenRouter or Vercel AI Gateway. Each part switches on and off by itself in `/jev`:
  - **Model routing.** Before a builder starts a task, Jev judges what it needs, and simple work builds on a cheaper, faster model. It never goes above the model you chose with `/model`, and keeps it for anything touching money, credentials or production. The choice shows on the task's timeline.
  - **Scope check.** When a builder hands work over, Jev checks whether its evidence shows each criterion is met, rather than just saying so. Weak work goes back to the builder before you see it (twice at most). What's still doubtful is marked **unproven** in your review, on the board and on your phone.

  First-time setup offers it once, after Slack and Telegram (skip it and `/jev` connects it later). Jev sees task descriptions and builders' reports, never code. It costs a fraction of a cent per task, and if it can't be reached Dazza works as it did without it. `dazza doctor` checks the key.

## 0.1.5

- **Built like a senior engineer and a designer would, even from one line.** A short request is treated as a brief to fill out properly (every screen's empty, loading and error states, validation, phones, keyboard access, realistic data), not a thin build and not a quiz. Every plan with a screen now has a design direction (feel, colour tokens, type, spacing, components, what to avoid) that you see in the play-back, set up as code in the first task. Builders follow a UI standard that rules out the generic AI look, and review their own screenshots like a designer before handing over. Dazza refuses handoffs with TODO comments, unimplemented stubs or lorem ipsum.
- **Plans sized to what you asked for.** Dazza plans the smallest version that does the job, and offers anything bigger as a later stage instead of building it in. It aims for a first stage you can open and try within about an hour, and T1 ends with the app starting and showing something. The plan card says when that is.
- **You always know how long's left.** While it builds, the status line counts down the task and the whole build (`Building T3 · ~12 min left · all built in ~40 min`), calibrated to how long tasks take on your project and to tasks building side by side. `/status` and your phone say it too.
- **Reviews start with trying it.** Work in review leads with what it does and how to try it, then screenshots, with file counts last. The board has a **Try it** button that starts the work on your computer and opens it, as `/try` does.
- **`/settings`:** everything that changes how Dazza works, in one list with sensible defaults. The old commands still work. Dazza mentions a setting when it matters (leaving mid-build, waiting on a review).
- **Easier setup.** If Claude Code or Codex isn't installed, Dazza offers to install it and sign you in, instead of stopping. An expired sign-in is fixed on the spot. Missing git is spotted up front, with a one-step install on a Mac or Windows. An old Node gets a clear message.
- **Faster builds.** Each task used to reinstall every dependency in its fresh checkout, which for an Electron or Next app was most of a small task's time. Now it starts with the packages already installed, copied from your checkout or an earlier task with the same lockfile (an instant clone on a Mac), and a finished task's packages are kept for the next.
- **Building doesn't stop for your review.** When a task is waiting for you, the tasks that need it start on top of its work. It all still lands only once you've approved it, and starting a task over starts over what was built on it. `/build-ahead off` waits for approval, as before.
- **Keep building with the terminal closed, if you want.** `/background on` lets a build carry on after you close the terminal (it's off by default). Stop it with `dazza stop` from any terminal, or "stop" from your phone. Opening `dazza` in the project takes it back. It also stops once the plan is built or after 12 quiet hours, and tells your phone why. On a Mac it keeps the computer awake while it builds.
- **`/phone-merge off`:** approving from Slack or Telegram no longer merges. Work is merged only from the terminal or the board, so someone who gets into your Slack or Telegram can't merge code. On by default.
- **Your tokens are in the keychain.** Slack and Telegram tokens and API keys move out of Dazza's config files into the macOS Keychain, your Linux keyring, or (on Windows) encryption tied to your sign-in. Ones saved before move over on their own. `dazza doctor` says where they're kept.
- **Windows: `/try` and screenshots start `npm run dev` again** when Node is installed in `C:\Program Files` (the default). Dazza ran npm's path unquoted, and Windows stopped at the space: "'C:\Program' is not recognized".
- **Windows:** file paths read `src/app.ts`, not `src\app.ts`; dragging a file into the terminal works; `/try` serves static sites; stopping `/try`, a `!` command, or a builder stops everything it started; stray dev servers a builder left are cleaned up. The tests now pass on Windows too.
- **The board has a key.** It only answers links that carry the project's own random key, which Dazza adds to every link it gives you. Other people on your network and other websites can no longer read it. Builders can't read the key.
- **Linux:** Dazza reads process start times from `/proc`, so it no longer relies on a `ps` that some systems don't have. CI now runs on Linux, macOS and Windows.
- The README and security notes say more plainly what the guard does and doesn't cover.

## 0.1.4

- **Replies stream in** as they're written, the way Claude Code shows them (on Claude Code).
- **`!` mode:** `!npm test` runs a command in your own shell, in the project. Dazza hears the command, its exit code and output with your next message.
- **`@` mentions and screenshots:** type `@` for a menu of the project's files; Ctrl+V pastes an image from the clipboard (or drag one into the terminal) and Dazza looks at it.
- **Multi-line messages** (`\` then Enter, Option+Enter or Ctrl+J), and ↑ recalls messages from earlier sessions too.
- **`/context`** shows how full the conversation is; past 70% Dazza suggests `/compact`.

## 0.1.3

- **Feels like Claude Code.** The chat shows what it's doing as it goes: files it reads (grouped), web look-ups, your MCP tools, and changes to the plan. Builders' edits show a short diff again. Markdown links read as text. Esc stops Dazza's reply (not the build), and the spinner says so.
- **Conversations like Claude Code's.** `dazza` starts a new conversation; `/continue` or `dazza --continue` picks up the last one, and nothing is lost switching between them. `/compact` summarises the conversation with Claude Code's or Codex's own compaction, and automatic compactions show up in the chat.
- **Your MCP servers.** Dazza's chat can use the MCP servers you have in Claude Code or Codex (your email, calendar, docs, trackers), found as needed so they don't bloat each message. It asks before anything that sends, posts or changes something there. `/mcp` lists them; `/mcp off` switches them off. Builders never get them.
- Dazza no longer tells the model a folder is empty when it has files but no code yet.

## 0.1.2

- **Web access.** Dazza's chat can search the web and read pages while scoping: current prices and free tiers, what a host supports, library versions, and any link you paste. Builders keep theirs, and can once again watch and stop what they run in the background (like a dev server) and edit Jupyter notebooks. On Codex, web search is now live rather than a cached index.
- **Your messages stand out** in the terminal, on a shaded band, so they don't blend into Dazza's replies.
- **Photos from your phone:** a Slack or Telegram message with a photo or file no longer goes unanswered. Dazza gets its words, and says it can't see images from there yet.
- **Update notice:** once a day, Dazza checks whether a newer version is out, and says how to update (also in `dazza doctor`). `DAZZA_NO_UPDATE_CHECK=1` turns it off.
- **Safety:** the guard now checks every tool that runs commands, not just the shell, and protects Dazza's own settings wherever `DAZZA_CONFIG_DIR` or `XDG_CONFIG_HOME` put them.
- Screenshots on Windows find Chrome installed for one user.

## 0.1.1

- **Windows:** Dazza now finds Claude Code and Codex however they were installed. npm installs them as `.cmd` wrappers, which Dazza couldn't start, so it reported them as not installed. `/try` can run `npm` again for the same reason. Dazza's guard also understands the `/c/Users/...` paths Git Bash uses, and quotes its hook command so a Node path with spaces works.

## 0.1.0

The first release.

- **Scoping, run like a meeting.** Dazza reads your code, asks a few plain-language questions at a time, recaps what's settled, and asks what goes wrong today. It checks the plan can work (hosting included), then plays back what it'll build before writing a scope document and tasks with subtasks, acceptance criteria, sizes and milestones.
- **Building beside you.** Each task is built in its own git worktree and branch, two at a time by default, while you keep talking to Dazza. Builders leave notes for the ones after them.
- **Handoffs with proof.** Every acceptance criterion comes with evidence. UI work comes with screenshots. Secrets, local-only files and template leftovers are refused. `/try` installs and starts the work so you can try it, then `/accept` merges it and `/changes` sends it back.
- **Dazza's guard**, on Claude Code and Codex alike. It never pushes, deploys, uses `sudo` or touches anything outside the task. It asks you first before remote databases, deleting data, machine-wide installs or starting containers.
- **Change control.** Proposals come with their cost. Accepted changes update the scope's change log, and every scope version is kept and can be restored. `/redo` starts a task over.
- **The board**, at localhost:4777: dashboard, milestones, tasks, a live build view, an editable scope with an acceptance-criteria table, and the close-out report.
- **Away from your desk:** Slack (Socket Mode) or Telegram, with buttons for approvals and permissions, plus desktop notifications.
- Claude Code (subscription or API key) and Codex (ChatGPT or API key).
