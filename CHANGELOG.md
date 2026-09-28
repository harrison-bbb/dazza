# Changelog

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
