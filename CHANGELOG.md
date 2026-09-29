# Changelog

## 0.1.5

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
