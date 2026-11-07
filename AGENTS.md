# Contributor guide

This guide is for anyone changing Codex Mods, including coding agents. [CONTRIBUTING.md](CONTRIBUTING.md) has setup, tests, lint and
commit style.

## Orientation

- [README.md](README.md): what it is, its status and how to start.
- [ARCHITECTURE.md](ARCHITECTURE.md): how it works. It is a living document: when a change alters the design, update the relevant
  section in the same change.
- [CONTEXT.md](CONTEXT.md): vocabulary.
- [docs/graph/](docs/graph/): the object graph of the app's features, which mods use as `ctx.graph`.
- [docs/AUTHORING.md](docs/AUTHORING.md): writing a mod.
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): tests, the QA harness and adapter refresh. [docs/OPERATIONS.md](docs/OPERATIONS.md):
  running a daily copy.
- Code comments sometimes cite design notes (`docs/design/…`) from the project's design history, which is kept outside this repository.

`contracts/` and `sdk/index.d.ts` are the public contracts. They may evolve, but update the spec, the consumers and the tests together.
The SDK is what mod authors build against, so prefer additive changes and say so in the commit message when a change breaks one.

## Layout

| Path | Contents |
|---|---|
| `loader/` | The loader that runs first in the copy's main process: instance lock, concurrency guard, boot decision, passthrough |
| `relay/` | The stdio-to-socket relay the app launches as its app-server |
| `framework/main/` | framework-main (Electron main): Host supervision, preload, views, relaunch |
| `framework/host/` | The Host: mux, mod runtime, ops journal, packages, recovery, management API |
| `framework/renderer/`, `preload/`, `shared/` | The renderer runtime, the preload and shared helpers |
| `framework/mods/` | The framework's internal mods (mod intelligence): shipped with it, started by the Host, never packages |
| `builder/` | Builds, signs and verifies the modded copy; adapter refresh; Keychain analysis (`KEYCHAIN.md`) |
| `adapters/` | Per-build adapter packs (`adapter.json`, `NOTES.md`) and the tools that generate them |
| `cli/` | The `codexmods` command line |
| `contracts/` | Type contracts, the on-disk layout and the upstream app-server protocol schemas |
| `sdk/` | The mod-facing SDK, its testing kit and the starters |
| `mods/` | The maintained mods (`codexmods.*`) |
| `scripts/qa.mjs`, `scripts/qa/` | The native QA harness |
| `tests/` | Shared fixtures (the fake app-server) and cross-module integration tests |
| `docs/coverage/` | The graph's coverage ledger and the native censuses behind it |

Tests sit beside the code as `*.test.mjs`.

## Working

- **Tests.** Run `npm test` (Node 24). While iterating, focus a run with `node --test "<dir>/**/*.test.mjs"`. Before calling a change
  done, run the full suite in both `CODEXMODS_REAL_MODULES=1` and `0` modes, and `npm run lint`.
- **Dependencies.** Code that ships inside the copy uses Node built-ins only, because it runs inside the app with no install step. That
  covers `loader/`, `relay/`, `framework/`, `sdk/` and `mods/`. Tooling outside the app may use npm packages.
- **Design sources.** Plan the object graph from what a user sees and does, not from the app's internals.
- **Native checks.** When a change affects the running app, check it in an isolated QA copy (`scripts/qa.mjs`, as a separate macOS
  user), never in someone's daily copy without their OK.
- **Model traffic.** Manual checks may use live model traffic sparingly. Automated tests never do; they use the fake app-server and
  recorded captures.

## Safety (hard lines)

- **Stock app.** Never modify `/Applications/ChatGPT.app`. Reading the stock bundle is fine.
- **Keychain and credentials.** Never cause a Keychain prompt, and never read or change credentials, Keychain items other than the
  copy's own or test items, or another user's `~/.codex` or profile.
- **Shared Codex home.** `~/.codex` is shared with the stock app and the CLI. Do not edit it by hand.
- **Data you didn't create.** Don't delete untracked data you did not create.
- **Uncertain outcomes.** Never blindly replay an uncertain user mutation, and keep failure evidence.

## Done

A change is done when its tests pass, the docs it affects are current, and app-facing behaviour has been checked natively where
practical. Say plainly what was verified natively and what only by tests.
