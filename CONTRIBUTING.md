# Contributing

Thanks for helping. [AGENTS.md](AGENTS.md) is the full contributor guide (layout, safety lines, what "done" means); this page is the short version.

## Setup

Requires macOS and Node 24 or newer. There is no build step.

```bash
git clone <repository>
cd codex-mods
npm ci
```

`npm ci` installs only development tooling (ESLint). Everything that ships inside the app uses Node built-ins only.

## Tests

```bash
CODEXMODS_REAL_MODULES=1 npm test
CODEXMODS_REAL_MODULES=0 npm test
```

Run the suite in both modes before you call a change done. `1` boots the Host with the real modules in the integration harness; `0` replaces its other modules with test doubles. The expected result in each mode is 0 failures and 1 skip: the login-keychain round trip, which is opt-in (`CODEXMODS_TEST_LOGIN_KEYCHAIN=1`) because it writes a test item to your login keychain. Tests marked `stock:` read the installed ChatGPT app and skip when it is absent or a different build.

To focus a run: `node --test "framework/host/**/*.test.mjs"`. Tests sit beside the code as `*.test.mjs`, use the fake app-server and recorded captures, and never send live model traffic or launch the app. [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) covers the native QA harness.

## Lint

```bash
npm run lint
```

The configuration is `eslint.config.mjs`. Fix findings rather than silencing them; if a pattern is deliberate, change the rule in the config with a comment instead of rewriting working code.

## Code conventions

- ES modules (`.mjs`) on Node 24. The loader, framework-main and the preload are CommonJS (`.cjs`) because the app loads them that way.
- **Built-ins only in code that ships in the app**: `loader/`, `relay/`, `framework/`, `sdk/` and `mods/`. That code runs inside the app with no install step. Tooling outside the app (builder helpers, test tooling) may use npm packages, kept in its own `package.json`.
- Match the surrounding style: 2-space indentation, LF line endings, a final newline (see `.editorconfig`).
- Keep [ARCHITECTURE.md](ARCHITECTURE.md) current: when a change alters the design, update the relevant section in the same change.

## Contract and SDK changes

`contracts/` and `sdk/index.d.ts` are the public contracts, and the SDK is what mod authors build against.

1. Open an issue or a draft pull request describing the change and who is affected before writing much code.
2. Prefer additive changes. Avoid removing or changing the meaning of anything a mod can already call.
3. Change the spec ([ARCHITECTURE.md](ARCHITECTURE.md)), the contract files, every consumer and the tests together, in one change.
4. State any breaking change plainly in the commit message and the pull request.

## Commits

- One logical change per commit; commit as often as is useful.
- A short imperative subject line with no prefix, such as `Add the instance lock to the loader`. Use the body to say why when it is not obvious.
- Mention breaking SDK or contract changes in the message.
- Do not push to or force-push shared branches, or delete branches or tags, unless the maintainer asks.

## Safety

Never modify `/Applications/ChatGPT.app`, never cause a Keychain prompt a person has to answer, and never edit `~/.codex` by hand. The full list is in the "Safety" section of [AGENTS.md](AGENTS.md).

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
