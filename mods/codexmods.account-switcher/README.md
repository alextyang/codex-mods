# Account switcher

Several ChatGPT accounts in one app (GOAL.md goal 26). The framework keeps each account signed in and its usage read, and moves a chat
between accounts between turns. This mod decides where your chats run.

## What it does

- **Accounts.** Its Accounts page in Settings lists every account the Codex agent can use: the app's own, then the ones you added. For each
  it shows the usage, when the weekly limit resets, and how many chats run on it. **Add account** opens the new account's sign-in in your
  browser. An added account can sign out or be removed; its chats move to the app's account first.
- **New chats** start on the account whose limit resets soonest, while it has room (an automatic action: off until you turn on "Starts
  new chats on the account whose limit resets soonest"; the setting **Start new chats on the account whose limit resets soonest** turns it
  off without touching its permission).
- **Moving chats** (an automatic action: off until you turn on "Moves a chat to the account it should use" in its page's What it may do
  without asking). It only acts between a chat's turns:
  - **soon after a compaction**, and after a new chat's first turn, when the chat's context is small and a move costs least, the chat
    moves to the account whose limit resets soonest, if that isn't its own. Usage that resets soonest is used first, so none is left at a
    reset;
  - **right before an account runs out** (its most used limit at **Move chats off an account at**, 90% by default), the chats on it that
    weren't just compacted move off it at the end of their turn. The ones just compacted, and the one with the smallest context, stay
    and use what is left. Fewer chats hit the limit, above all ones with a large context, and the account's usage is still used in full;
  - an account that ran out or was signed out has all its chats moved off it.

  It waits 10 minutes before moving the same chat again, unless its account ran out.
- **A chat's menu** has "Run on <account>" for each of your other accounts. Native menus can't carry your intent, so the app asks you to
  confirm.

A moved chat is the same chat, with its history and settings. Its next turn starts the new account's prompt cache from scratch, which is
why the moves wait for a compaction.

## How it's built

| Part | Built from |
|---|---|
| The accounts and their usage | `CodexAgent.accounts`, each `ChatGPTAccount` and its `CodexUsage` |
| Where a chat runs | `Thread.account`; `Thread.moveToAccount(account)` between turns (the framework refuses it while the chat works) |
| New chats | `CodexAgent.setStartAccount(account)`, as its automatic action `place` |
| A compaction | `CodexThread`'s `compacted` event |
| Adding, signing in, removing | `CodexAgent.addAccount()`, `Account.signIn`, `signOut`, `remove`, as the user from its page |

Its credentials never reach it: each account's sign-in stays in that account's own Codex home, kept by its own app-server.

## Permissions

| Permission | For |
|---|---|
| `graph.read:CodexAgent,ChatGPTAccount,CodexUsage,CodexThread` | the accounts, their usage, the chats and where they run |
| `graph.act:CodexAgent.addAccount,CodexAgent.setStartAccount,Account.signIn,Account.signOut,Account.remove,Thread.moveToAccount` | its page's actions, new chats' account, and moving chats (its automatic action) |
| `graph.present:SettingsPage,Menu`, `ui` | its page and the chat menu entries |

## Tests

`test/account-switcher.test.mjs` tests an account's standing, the account new usage goes to, and where a chat runs after its turn. On a
test graph with the framework's accounts stood in for, it checks that new chats are placed and that a chat moves after it compacts, and
only while the automatic action is on. The framework's side (an added account's backend, moving a chat, new chats, removal) is tested in
`framework/host/graph/providers/codex/test/added-accounts.test.mjs` and `framework/host/mux/test/a13-framework-backends.test.mjs`.
