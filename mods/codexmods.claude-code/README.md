# Claude Code

Claude Code as an agent in Codex (GOAL.md goal 23). Start a chat with **New Claude Code chat** in the command palette; it starts in the project of the window's new chat and opens there. The app's own new chat stays Codex's. Its chats are listed with Codex's, and each is a real Claude Code session in the project's folder. Its steps, approvals and answers appear in Codex's own look.

## What it needs

The `claude` program installed on your Mac and signed in as you. The mod finds it on your PATH each time a session starts, and consent names it (`processes.exec:claude`). Your own Claude Code settings apply: your permission mode, the tools you've allowed, your `CLAUDE.md` files.

## How it works

- **Agent and models.** The mod registers its kinds with the graph, each a subtype of a framework concept:
  - `ClaudeAgent` (an Agent), with its models: Sonnet (the default), Opus and Haiku.
  - `ClaudeThread` (a Thread).
  - `ClaudeEdit` and `ClaudeTool` (Steps).

  Its command, "New Claude Code chat", calls the agent's `newThread` with the project of what the window shows (a chat's, or the new chat's), and so its folder, and opens the chat in that window. The framework lists its chats wherever chats are listed (the sidebar, search, the palette, notifications) and opens them to the view this mod registers (`ui.replace('ThreadView', {for: 'ClaudeThread'})`). That view is drawn with the parts the framework lends: the header, turns, messages, steps, approval cards and the composer with its model picker.
- **Sessions.** Each chat runs one instance of the mod's session process, `claude#<chat>`, in the chat's project folder:

  ```
  claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio --model <model> (--session-id <id> | --resume <id>)
  ```

  The session runs as the program speaks stream-json:
  - Your message is a line on its input.
  - Its answer streams in as text deltas.
  - A tool call becomes a step: a command (Bash), an edit with its diff (Edit, MultiEdit, Write), or another tool.
  - When Claude Code asks to use a tool (`can_use_tool`), the chat shows an approval with three options: allow once, allow for this chat, or don't allow.
  - Stop interrupts the turn. Claude Code then ends, and the turn ends stopped.
- **Going on.** The session's id is kept with the chat, so the chat continues in the same session (`--resume`) when:
  - you change the model (its next message starts the session with the new one);
  - the session was idle for 10 minutes (it is stopped then);
  - another chat needed its place (at most 8 sessions run at once, and the one idle longest gives way);
  - the app restarted.
- **Kept.** Its chats and their turns are kept in the mod's storage (`chats`). After a restart they're all there, and a turn the restart cut short ends failed.

## Permissions

| Permission | For |
|---|---|
| `graph` | providing its agent, models, chats and their turns |
| `graph.read:Draft,Project,Window` | the project of what the window shows (or the new chat's), and so its folder |
| `graph.contribute:Project` | its chats among the project's chats, as Codex's are |
| `graph.present:ThreadView,Palette` | its chats' own view, and its command |
| `graph.act:Window.open` | opening a new chat in the window it was started from |
| `ui` | that view |
| `processes`, `processes.exec:claude` | running `claude` as its session |

## Not covered yet

- Attachments and images in a message.
- Claude Code's own slash commands.
- Its plan mode.
- Its cost and usage reports.

Questions it asks through its own tools appear as tool steps.

## Tests

`test/claude-code.test.mjs` runs the chats against `test/fake-claude.mjs`, a stand-in that speaks stream-json as Claude Code 2.1 does. It was recorded from the real program on 2026-11-06 (no model traffic in tests). The QA copy's native check uses the same stand-in on its PATH.
