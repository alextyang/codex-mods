# Chat settings (`codexmods.thread-settings`)

A chat's settings in one tab of the side panel (GOAL.md goal 18). Open it from the chat's header (**Chat settings**) or the command
palette. It shows everything the graph has in the chat's `settings`, grouped by what defines each one:

1. **Codex**: the chat's model, reasoning effort and mode (its access is shown, not changed here: the app asks before full access).
2. **Each mod's settings for this chat**: whatever a mod declares with `"scope": "thread"` in its `mod.json`, and any Setting a mod
   contributes to the chat. Another mod's setting is changed as you (your own click), never by this mod alone.
3. **Each skill the chat can use** (installed, turned on, global or in the chat's project): a switch, **Use in this chat**, and the
   parameters the skill declares.

Every row is the framework's own `SettingRow`: the same controls, reset and errors as the Mods pages.

## What the agent is told

Every message you send in a Codex chat carries that chat's skill choices, as the turn's additional context under this mod's name, while
any of them differs from its default:

```
Skill settings for this chat, chosen by the user. They replace any earlier ones.
- Do not use these skills in this chat unless the user names one: notes.
- pdf-report: detail = "thorough", charts = true, maxPages = 10.
Apply these values whenever you use these skills.
```

A skill turned off for a chat is advice to the agent, not a hard switch: Codex has no per-chat skill switch, and its own switch
(Settings › Skills) applies to every chat. A skill's scripts get a value only through the agent.

## Declaring a skill's parameters

A skill declares its parameters in its `SKILL.md` frontmatter, under `metadata`, as one JSON object (JSON is a YAML flow mapping, so the file
stays valid YAML, and Codex's validator accepts any key under `metadata`):

```yaml
---
name: pdf-report
description: Build a PDF report from the project's data. Use when the user asks for a report.
metadata:
  x-codexmods-settings: {
    "version": 1,
    "settings": [
      { "key": "detail", "title": "Detail level", "kind": "choice", "control": "segmented",
        "options": ["brief", "normal", "thorough"], "default": "normal" },
      { "key": "charts", "title": "Include charts", "kind": "toggle", "default": true },
      { "key": "maxPages", "title": "Page limit", "kind": "number", "min": 1, "max": 50, "default": 10, "unit": "pages" }
    ]
  }
---
```

Each entry is a mod's setting declaration (`contracts/manifest.d.ts`, `SettingDeclaration`) for the kinds a skill may use:

| Field | |
|---|---|
| `key` | Letters, digits, `-` and `_`, starting with a letter; unique in the skill; not `enabled` |
| `title` | Required, at most 80 characters |
| `kind` | `toggle`, `choice`, `text` or `number` |
| `default` | Required, valid for its kind |
| `description` | Optional, at most 300 characters |
| `control` | A choice: `select` or `segmented`; a number: `stepper` or `slider`; a text: `line` or `area` |
| `options` | A choice's 1 to 32 options: a string (its own value and label), or `{value, label, description?}` |
| `min`, `max`, `step`, `unit` | A number's |
| `placeholder` | A text's |

At most 24 parameters. A skill whose block is not valid shows only its switch, and this mod's log says why. The values are the chat's
own, kept in this mod's storage; a change applies from the next message.

## Permissions

| Grant | Why |
|---|---|
| `graph.read:Thread,Setting,SettingsSection,Skill,Mod,Agent` | Read a chat's settings, the skills it can use, and the names of what defines them |
| `graph.contribute:Thread,Skill` | Add the skills' settings to each chat, defined by their skill |
| `graph.act:Setting.set,Setting.reset` | Change a setting from the panel (another mod's only as you) |
| `graph.intercept:CodexThread.send`, `graph.act:CodexThread.send` | Give the agent the chat's skill choices with each message |
| `graph.present:SidePanel,ThreadHeader,Palette` | The panel tab, the header action and the command |
