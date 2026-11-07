# Codex Mods

A modding framework for the Codex/ChatGPT desktop app on macOS. Mods are installed, configured, updated, rolled back and removed from the app's own Settings. They reach the app only through shared framework seams: one app-server mux, a UI plane that uses the app's real components, and a small SDK.

The stock app is never modified. A builder makes a separate, uniformly signed **modded copy** from it, isolated from the stock app's Keychain item, updater and Computer Use helper. The copy can replace the stock app for daily use and shares `~/.codex` with it. Failed updates and broken mods fall back to last-known-good, safe mode, or the unmodified app.

Codex Mods is an independent project. It is not made, endorsed or supported by OpenAI. ChatGPT and Codex are OpenAI's trademarks. Use it under the terms that apply to your use of the ChatGPT app.

## Status

Pre-release (`1.0.0-dev`). The framework, the SDK and the maintained mods work on the app builds in `adapters/`. Each app update may need a refreshed adapter pack before the copy builds on it. Compatibility with a new build is best-effort, and the framework says when a mod or a feature is at risk (Settings → Mods). There are no prebuilt or notarized copies: each user builds their own from their own stock app.

## How it keeps you safe

- The stock app is never modified, and the copy keeps its own Keychain item, updater and Computer Use helper.
- A mod is trusted code, as any program you install (it is not sandboxed). What it asks for is shown before you enable it, and the framework enforces its grants on the app's features. A mod acting alone on what is yours (sending, stopping, deleting, signing out) asks you first, unless you turned on that automatic action for it.
- An update is staged and checked before it applies. A broken update or mod falls back to last-known-good, safe mode or the stock app.

[SECURITY.md](SECURITY.md) has the details and how to report an issue.

## Quick start

Requires macOS, Node 24+, the stock ChatGPT app and, for a daily copy, an Apple Development certificate.

The simplest way is **Codex Mods Setup**, from the [latest release](https://github.com/alextyang/codex-mods/releases/latest) (or `node setup-app/build.mjs`): it checks your Mac, backs up your Codex data, builds the copy, puts it in your Dock, and later rebuilds or uninstalls it ([setup-app/README.md](setup-app/README.md)). From a terminal:

```bash
node cli/codexmods.mjs setup --daily --identity "Apple Development: Your Name (ABCDE12345)"
```

This installs the framework, builds the copy from your installed ChatGPT and creates `~/Applications/ChatGPT Mods.app` (`--try` instead of `--daily` makes a copy with its own data, to try it). Then open it, sign in, and add mods from Settings › Mods, where the maintained mods are recommended. Setup, updates, recovery and rollback are in [docs/OPERATIONS.md](docs/OPERATIONS.md). To write a mod, start from a starter with `node cli/codexmods.mjs new <id> --kind panel|rule|contribution|agent` and read [docs/AUTHORING.md](docs/AUTHORING.md); the maintained mods in `mods/` are worked examples.

Run the tests with `npm test` and the linter with `npm run lint`; see [CONTRIBUTING.md](CONTRIBUTING.md) before sending a change. Tests that read the stock app skip when it is not installed. Native checks (optional) use an isolated QA copy under a separate macOS user; see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Documents

- [ARCHITECTURE.md](ARCHITECTURE.md): how it is built.
- [CONTEXT.md](CONTEXT.md): vocabulary.
- [docs/AUTHORING.md](docs/AUTHORING.md): writing a mod, from the SDK's starters.
- [docs/graph/](docs/graph/): the object graph of the app's features, which mods use as `ctx.graph`: its types, presentations and features.
- [AGENTS.md](AGENTS.md): contributor guide.
- [CONTRIBUTING.md](CONTRIBUTING.md): setup, tests, lint, conventions and commit style.
- [SECURITY.md](SECURITY.md): reporting issues; mods are trusted, unsandboxed code.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md): how we work together.
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): machines, tests, the QA harness, adapter refresh.
- [docs/OPERATIONS.md](docs/OPERATIONS.md): running a daily copy.
- `adapters/*/NOTES.md`, `builder/KEYCHAIN.md`: per-build and Keychain findings.

## License

[MIT](LICENSE) © 2026 Alex Yang. Material that comes from or describes OpenAI's app (glyphs, adapter packs, the app-server's protocol
schemas) is included for interoperability and is not under the MIT License: see [NOTICE](NOTICE).
