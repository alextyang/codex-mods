# Mod intelligence

The framework's internal mod for mods' model use (GOAL.md goal 16, docs/design/reference-mods.md §2). The framework ships it in `framework/mods/`, starts it before the user's mods, and integrates with it (`framework/host/internal-mods.mjs`). It is never installed, updated, replaced or removed as a package; its id is reserved.

## For a mod author

Declare model use in `mod.json`, saying why:

```json
"intelligence": { "why": "It drafts commit messages", "tools": ["web"] }
```

`tools` lists the other kinds of tool your model use would like: `web`, `network`, `files`, `toolServers`, `plugins` and `computerUse`. Each is the user's to allow. Of these, only `web` (web search) is provided so far. The user's own tool servers (MCP) are turned off for every managed thread: the call reads the effective config first and refuses when it cannot, so a thread never runs with a server the user did not give the mod. What a running call uses counts toward its allowance as it goes (past it, the call is stopped), and its thread is unloaded when its turn ends.

Then call it from any realm:

```js
const { text, usage } = await ctx.intelligence.ask({
  prompt: 'Summarize these changes: …',
  storage: true,                    // your storage as tools: storage_get, storage_set, storage_keys
  settings: true,                   // your settings as tools: settings_get, settings_set
  tools: { tag: { description: 'Tag the chat', input: { type: 'object', properties: { name: { type: 'string' } } }, run: ({ name }) => tag(name) } },
  onText: (delta) => show(delta),   // the text as it streams
});
```

A call throws, saying why, when:
- the user hasn't turned your model use on;
- an allowance is used up;
- a limit is reached;
- the account is near its limit;
- the call fails.

`ctx.intelligence.status()` says whether your model use is on and what it has used.

## What the user controls

Each mod's page in Settings, Mods has a **Model use** section:
- the switch, off until the user turns it on;
- the model (Luna by default, or another of Codex's);
- the tokens it may use an hour and a day;
- the other kinds of tool it asks for, each off until allowed;
- what it used;
- Stop while a call runs.

The **Mod intelligence** page in Settings lists every mod's use, with the total. Consent shows the declaration among the mod's permissions, never granted there.

## How it runs

- **Calls.** A call reaches the `model` service, which knows the calling mod. Each call is one ephemeral Codex thread on the app's connection, started in a folder under this mod's data folder (`threads/<call>`). The mux keeps that thread private to this mod: the app never hears of it, and no other mod can observe or intercept it.
- **The thread.** It runs with:
  - approvals off and a read-only sandbox;
  - Codex's own tools off (shell, patches, images, apps, plugins, memories, browser and computer use, hooks; web search unless allowed);
  - the user's setup off (AGENTS.md, skills);
  - the calling mod's tools in one namespace (`mod`), plus the framework's instructions, then the call's.
- **Tools and the answer.** A tool call is answered by the calling mod in its own realm, through a service its ctx provides for that call alone, which only this mod may call. The streamed text and the answer reach the mod the same way.
- **Tokens** come from the thread's token reports. They count against the mod's allowance and are kept in this mod's storage (`uses`).
- **Guardrails:**
  - the allowance per hour and per day;
  - 30 calls a minute;
  - 4 calls of a mod at once;
  - a prompt of at most 200 000 characters;
  - a call of at most 300 s (60 s by default);
  - no call while the account's limit is 95% used;
  - the switch, which ends a mod's running calls at once.

## Tests

`test/intelligence.test.mjs` tests the guardrails, the thread's settings, and a mod's call end to end on the real mux and the fake app-server.
