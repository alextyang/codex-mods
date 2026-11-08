# Codex Mods Setup

A Mac app that sets up Codex Mods in one window: it checks this Mac, lets you choose how you will use the copy, builds it and puts it in your Dock. Opened again later, it rebuilds the copy or uninstalls it.

It runs `codexmods setup` underneath and adds what a window can do better than a command:

- **Check:** the installed ChatGPT build and whether an adapter pack supports it (and the newest that is supported when it is not), Node.js 24 or newer, your Apple Development certificates, the size of `~/.codex`, and whether ChatGPT or `codex` is running.
- **Choose:** *every day* (the copy shares `~/.codex` with ChatGPT and needs your certificate) or *to try it* (its own sign-in and data). Then whether to back up `~/.codex` first (without the chats and their worktrees), put the copy in the Dock, and rebuild it when ChatGPT updates (the copy's update policy, `auto` or `offer`).
- **Build:** the backup (an APFS clone in a new folder `~/CodexModsBackup/codex-<date>-<id>`, following `~/.codex` if it is a link; it leaves out the chats, `sessions`, `archived_sessions` and their index, and the chats' `worktrees`, which are most of the data's size), the framework, the copy (built, signed and checked to be isolated), the Dock and the update policy, each shown as it goes.
- **Dock:** for every day the copy takes ChatGPT's place; to try it, it goes beside ChatGPT. The Dock as it was is kept in the root (`setup-dock-before.json`), and uninstalling puts back exactly what was there.
- **Uninstall:** refused while the copy runs. It puts the Dock back and removes the launch path (`~/Applications/ChatGPT Mods.app`) and the framework's code and built copies: in `apps`, `framework`, `adapters` and `updates` under the root, only the entries the framework makes there. Setup only uses an empty folder or one it set up before. Your mods, their data and settings, the try-it copy's own chats, `~/.codex` and every backup stay, so setting up again brings your mods back.

ChatGPT itself is never changed.

## Build it

```bash
node setup-app/build.mjs --zip
```

It needs Xcode's command line tools. The app is universal (Apple silicon and Intel) and carries the framework tree it sets up from (`--source <tree>` picks another, such as the public tree). It is signed ad hoc unless you pass `--identity "<name>"`. An app signed ad hoc and downloaded from the internet is stopped by Gatekeeper the first time: open it from Finder with Control-click › Open, or allow it in System Settings › Privacy & Security.

From a checkout, `node setup-app/server.mjs` prints the page's address (with this run's token) for a browser on this Mac.

## How it is made

- `mac/main.swift`: the window. It starts the server with the Node.js it finds (`CODEX_MODS_NODE`, Homebrew's, `/usr/local/bin`, or a login shell's), loads the address the server prints, and stops the server when it quits.
- `server.mjs`: the page and its API on 127.0.0.1. Each call needs this run's token (from the page's address after `#`), this server's own Host and, when sent, its own Origin. One job runs at a time.
- `steps.mjs`: check, install, uninstall, open and reveal, with the Mac's tools standing in for tests.
- `dock.mjs`, `plist.mjs`: the Dock's preferences read with `defaults export` and written back with `defaults import` without loss; only the copy's and ChatGPT's tiles are touched.
- `ui/`: the page, in the Codex app's look (its colour, type and spacing tokens, light and dark).

For QA, `CODEX_MODS_ROOT` points it at another root and `CODEX_MODS_SETUP_STOCK` at another ChatGPT.
