# Project orchestrator

A project's orchestrator (GOAL.md goal 25): a chat that learns the project, settles its open questions with you, hears what the project's other chats do, and coordinates the work with you.

## Using it

Choose **New project orchestrator** in a project's menu (right-click it in the sidebar). This starts a chat in the project and opens it. The chat is a Codex chat, marked **Orchestrator** in the sidebar and its header.

1. **It learns the project.** Its first message has it read the project's goals and plans (GOAL.md, README, docs, whatever the project keeps), what's done and what isn't, and the project's current chats.
2. **It grills you.** It settles the open questions one at a time with the grill-me skill. This mod adds that skill to your Codex skills, so you can use `$grill-me` in any chat too.
3. **It hears the project.** Each message it gets says what changed in the project's other chats since its last one (a chat started, is waiting for you, finished), with a digest of them all. Turn on "Tells the orchestrator when one of its project's chats finishes" (its page's What it may do without asking), and it's also told when a chat finishes, so it can act on it.
4. **It coordinates.** Its tools list the project's chats, read one's recent turns, send a message to a chat, or start a new chat with a prompt. Codex Mods asks you before it sends a message or starts a chat.

## How it's built

| Part | Built from |
|---|---|
| The role | this mod's attached data on the chat (`@codexmods.project-orchestrator/role`), shown by a `ui.decorate('Thread')` badge |
| Starting it | a project menu entry (`ui.contextMenu.add`, the user's intent) calling `Project.newThread({prompt, send, open})` as the user |
| Instructions and tools | a `CodexAgent._startThread` interceptor, for the start the user just asked for only |
| Each turn's context | a `CodexThread.send` interceptor on orchestrator chats (additional context) |
| Updates | a view of Codex's chats; an automatic action (`Thread.send`) while the user has it on |
| Tools | a `Tool._call` interceptor answering only orchestrator chats, about their own project |
| grill-me | its `skills/` folder among the session's skill roots (`CodexAgent._setSkillRoots`) |

## Tests

`test/project-orchestrator.test.mjs`, on the testing kit's offline agent.
