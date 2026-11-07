# Better questions (`codexmods.better-questions`)

The agent asks you better (GOAL.md goal 22): with a form, in a window of its own or by iMessage.

## What it does

- **Its own tool, `ask_user`**, added to each new Codex chat (the agent's dynamic tools, under this mod's namespace), with instructions
  to use it instead of asking in plain text or with Codex's own question tool. A call carries a title, a message and 1 to 12 fields:
  a choice (with or without the user's own words), yes or no, a number, or text.
- **The Questions view**: every open question, its own and Codex's own (CodexQuestion, pending), each drawn with the framework's question
  card. It opens by itself in the window in front when a question comes (setting **Open questions**: a window of its own, a tab beside the
  chat, or only when you open it), with a notification when the app is in the background. Your answer there is yours: the card carries
  your own click (graph-integrity G7), so Codex's questions are answered as you.
- **Later answers.** The tool waits up to ten minutes. If you have not answered, the agent is told your answer will come as your next
  message, and goes on; when you answer, the mod sends it to that chat. Open questions are kept in the mod's storage, so they survive a
  restart.
- **iMessage** (off by default): a question of its tool still open after the delay you set is texted to your phone through your own
  Sendblue account (its key and secret on the mod's iMessage tab, kept in your Keychain), with a short code. The first reply answers it:
  one answer per line, a number picks a choice. One question is out at a time, so a reply always matches. Sending your reply to the chat
  is the mod's automatic action `imessage`: off until you turn it on, and each send asks you while it is off.

Codex's own question tool stays: its questions show in the app as always, and in this mod's view too. The framework lets no mod hide
the app's answers to a request.

**Permissions:** `ui`, `graph`, `graph.read:CodexQuestion,Thread,Window`, `graph.intercept:CodexAgent._startThread,Tool._call`,
`graph.act:CodexAgent._startThread,Tool._call,CodexQuestion.answer,CodexQuestion.skip,CodexThread.send,Window.focus` (its popup brought forward), `graph.present:SidePanel,SettingsPage`,
`secrets` (the Sendblue key) and `network` (Sendblue).
