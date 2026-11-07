# Live usage (`codexmods.live-usage`)

Your limits between whole percentage points, your pace, each chat's share, and a reserve (GOAL.md goal 21). Built on the graph's facts
alone: every token report the agent gets (a Codex chat's `tokenUsageReported`) and every rate-limit report (CodexUsage's snapshots). All
analysis is the mod's own.

## What it shows

- **The estimate.** Codex reports a limit in whole percentage points, only when a response ends. Each time a window moves, the mod learns
  what a point costs from the responses in between (uncached input, cached input at a tenth, output at six, smoothed over moves); between
  moves it adds the cost since the last move. Until it has seen a window move it shows the whole point.
- **Pace and time left**: the cost of the last half hour as a percentage per hour, and the hours left at that pace.
- **Each chat's share** of the most used window.
- A status in the composer and the title bar (setting **Show usage in**), and its page in Settings (a tab of the mod's page): each limit,
  the reserve and what it holds, the chats that used the most.

Windows are named by their length (weekly, daily, five-hour), never by `primary` and `secondary`.

With several accounts (the Account switcher, GOAL.md goal 26) each account has its own estimate: a chat's responses count toward the
account it runs on, and the status shows the account your chats use now.

## The reserve

With **Reserve** above 0, once the most used limit of a chat's account reaches it:
- a message you send in a Codex chat is held (stopped quietly, kept first), and the composer says why;
- with **Stop working chats at the reserve**, a chat that is working is stopped too, and told to continue after the reset;
- when the limit resets, the held messages are sent and the stopped chats get "Continue". Each send has its own key, so a send that may
  have happened before a crash is never sent twice.
- A chat can **Keep working past the reserve** from its own settings (Chat settings shows it).

Sending and stopping on its own are the mod's **automatic actions** (`resume`, `pause`): off until you turn them on (the mod's Permissions
tab); while off, each one asks you. **Release held messages** on its page drops what it holds.

## The menu bar app

The mod issues a `menubar` lease (descriptor in `files/lease.json`, mode 0600) and serves `usage.snapshot` (schemaVersion 1: `status`,
`totals`, `active`, `concurrency`, `rateLimits` by limit, `coverage`, and now `estimates` and `reserve`) for the Codex Live Usage menu bar
app. It keeps metadata only: no answers and no account identity, and the messages it holds only until it sends or releases them.

**Permissions:** `ui`, `graph`, `graph.read:CodexThread,CodexUsage`, `graph.intercept:CodexThread.send`, `graph.act:CodexThread.send,
CodexThread.stop`, `graph.present:Composer,Window,SettingsPage` (the status in the composer and the title bar, its page), `appServer.clients`.
