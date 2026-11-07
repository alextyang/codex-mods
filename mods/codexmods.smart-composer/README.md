# Smart composer

Luna in the composer (GOAL.md goal 24). It runs through mod intelligence: turn its model use on in its page's Model use section first. It uses your Codex account within the allowance you give it, and without model use it does nothing.

## What it does

- **Suggest as you type** (on by default). Pause at the end of a line and Luna continues what you're typing. The suggestion is ghost text after the caret: Tab takes it, Escape leaves it, and typing anything else clears it. It's asked after a pause of 0.7 s, once a line holds at least 12 characters, and never while you type a mention or a slash command.
- **Ask before sending** (off by default). When you send in a chat, Luna reviews the message (a new chat's first message goes as it is: the app makes the chat as it's sent, and stopping it would leave an empty chat). If something is unclear, the send is stopped quietly (your text stays in the composer) and up to three questions show above the composer. Answer them and the message goes with your answers; skip them and it goes as it was.
- **Pick the reasoning effort** (an automatic action: off until you turn on "Sends each message you write with the reasoning effort its task needs" in its page's What it may do without asking). The same review says how much reasoning the task needs (low, medium, high or extra high), and the message is sent with that effort, or the nearest the chat's model offers. The chat keeps its model, so its prompt cache keeps working. Changing your message is the mod's act, so it happens only while you have it on, never asking at each message.
- **Pick the model for a new chat** (off by default). On a chat's first message, before it has a cache to keep, the review can choose between a fast model and a strong one (its settings).

If the review is off, refused (model use off, an allowance used up) or fails, the message goes as it is.

## How it's built

| Part | Built from |
|---|---|
| Suggestions | `ui.composer.suggest` (the framework draws the ghost text and keys); `ctx.intelligence.ask` from the renderer realm |
| Questions | a `Draft.send` interceptor (a stop keeps the text); a composer control above the input with the framework's question card; the answered text written with `Draft.setContent` and sent with `Draft.send` as the user |
| Effort and model | a `CodexThread.send` interceptor setting the send's `settings.effort` (and `settings.model` on a first message), as its automatic action `effort` while the user has it on |

## Permissions

| Permission | For |
|---|---|
| model use (`intelligence`) | Luna, off until you turn it on |
| `graph.read:Draft,CodexThread,Model` | the message, its chat, and the efforts its model offers |
| `graph.intercept:Draft.send,CodexThread.send` | the questions before a send, and each message's effort |
| `graph.act:Draft.setContent,Draft.send,CodexThread.send` | sending the message with your answers, and with its effort |
| `graph.present:Palette,Composer`, `ui` | the suggestions and the questions |

## Tests

`test/smart-composer.test.mjs` tests the review, the effort, the suggestion text, and with a stand-in for mod intelligence, a send stopped for its questions and a message's effort.
