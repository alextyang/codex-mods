# UI tweaks (`codexmods.ui-tweaks`)

Appearance settings for the things users complain about (GOAL.md goal 20). Every tweak is one rule of the framework's while it is set:
turn a tweak back to the app's own, or turn the mod off, and the app is as it was.

## Settings (Settings › Mods › UI tweaks)

| Setting | Choices | What it sets |
|---|---|---|
| Chat width | Default, Wide, Wider, Widest | `--thread-content-max-width` to the app's `--container-4xl`, `--container-5xl` or `--container-7xl` |
| Chat text | Smaller, the app's size, Larger, Largest | `--codex-chat-font-size-override` to the app's `--text-sm`, `--text-lg` or `--text-xl` |
| Code text | Smaller, the app's size, Larger | `--codex-chat-code-font-size-override` to the app's `--text-xs` or `--text-base` |
| Row height | Compact, Default, Roomy | `--height-token-row` to the app's `--control-size-sm` or `--control-size-lg` |
| Show steps expanded | on or off | each step opens with its detail until you close it (`graph.defaults` of StepBlock) |
| Unfold each turn | on or off | a finished turn shows its steps (`graph.defaults` of TurnView) |

Each size is one of the app's own variables set to another of the app's (`ui.style`: never a raw value), so a tweak keeps the app's scale
and follows its look in both themes. Another mod's rule may hold the same variable: the first in your order of mods wins, and the mod's
Activity tab says when its rule lost.

**Hidden parts** (a tab of the mod's page) lists what each place of the app draws, by the names the framework gives them (`ui.parts`):
the sidebar's sections and footer, chat rows, the title bar, the chat header, the composer, the new chat page, turns, messages, steps,
menus, the side panel and the status items. Check what you never use; it is hidden in every window (`ui.hide`). Stop, Settings, signing
in and out, and every answer to a request are never offered: the framework does not let a mod hide them.

**Permissions:** `ui`, `graph`, `graph.present` (styling and hiding in the places listed), `graph.act:StepBlock._expand,StepBlock._collapse,
TurnView._expand,TurnView._collapse` (the open-by-default choices).
