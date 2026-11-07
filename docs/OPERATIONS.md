# Operations

How to run the modded copy as your daily app: set it up, update it, recover it, and back out. For the design behind each rule see [ARCHITECTURE.md](../ARCHITECTURE.md); for tests and the QA harness see [DEVELOPMENT.md](DEVELOPMENT.md).

The daily profile shares `~/.codex` with the stock app and the CLI, so threads and config match. This is the one setup that touches real credentials and real history, so do it deliberately: use a Terminal on the Mac itself for the steps that may show a signing or Keychain dialog (an ssh session cannot answer one).

```bash
CM_ROOT="$HOME/Library/Application Support/CodexMods"          # default root
cm() { node "<checkout>/cli/codexmods.mjs" "$@" --root "$CM_ROOT" --profile default; }
APP="$HOME/Applications/ChatGPT Mods.app"                      # stable launch symlink -> current candidate
OWL="$HOME/Library/Application Support/ChatGPT Mods"           # the copy's userData
owned() { pgrep -fl 'ChatGPT Mods|CodexMods|codexmods-relay|entry-node\.mjs|CUAServicf'; }   # copy-owned processes
```

Node 24 or newer is required. `cm ops …` needs a running Host; use `owned` to see processes.

## 1. Before you start

- The stock ChatGPT app is installed, and an adapter pack that satisfies the isolation baseline exists for its build (`adapters/`; an older pack without `mandatoryEdits` is refused). Without a pack, `setup` stops after installing the framework and says so; see "Adapter refresh" in DEVELOPMENT.md.
- An Apple Development certificate is in your login keychain: `security find-identity -v -p codesigning`. Its Team ID (the certificate's OU) is what the builder uses to team-match the copy; it is derived from the certificate and a mismatch fails the build.
- **Back up** with every writer stopped (quit the stock app, every `codex` CLI session, menu-bar apps and the iMessage service; `pgrep -fl 'ChatGPT|codex'` should be empty):

  ```bash
  B="$HOME/CodexModsBackup/$(date +%Y%m%d-%H%M)"; mkdir -p "$B" && chmod 700 "$B"
  ditto ~/.codex "$B/codex-home"
  for d in "$CM_ROOT" "$OWL"; do [ -d "$d" ] && ditto "$d" "$B/$(basename "$d")"; done
  cp ~/.codex/config.toml "$B/config.toml.pre"
  readlink "$APP" > "$B/launch-target.pre" 2>/dev/null || true
  ```

  `codex-home` contains `auth.json`. Keep the backup local; never sync or share it.

## 2. Set up and build

```bash
cm setup --daily --identity "Apple Development: Your Name (ABCDE12345)"
```

Setup installs the framework, writes `profile.json` (shared `~/.codex`, concurrency guard on), builds the copy from the installed stock app, and creates `$APP`. It is idempotent: a second run changes nothing unless a build input changed, and then it says which one. `--try` instead makes a copy to try it: its own Codex home under the profile and its own user data, signed ad hoc if you like (`--identity -`).

**Codex Mods Setup** does the same in a window (`setup-app/README.md`; download it from the latest release or build it with `node setup-app/build.mjs`): it checks this Mac, backs up `~/.codex` first if you choose (an APFS clone in `~/CodexModsBackup`), runs this setup, puts the copy in the Dock (in ChatGPT's place for every day, beside it to try it) and sets the update policy. Opened again, it rebuilds the copy or uninstalls it (section 10).

- codesign may ask once for permission to use the signing key. Click **Always Allow**.
- Check the candidate's `build-report.json` (`readlink "$APP"`): `isolationBaseline.missing` is empty, `isolationScan.hits` is 0 (including the post-sign entitlement scan), `removedLockedUsePayload` is non-empty, `computerUseContainer.id` is `<TEAM>.com.openai.sky.CUAServicf` with `entitled` listing the app and helpers, every `mandatoryEdits` entry is applied, and the `updater` evidence is ok.
- `codesign --verify --deep --strict "$APP"` passes, and `codesign -dv` shows your TeamIdentifier on the app and each nested helper.

## 3. First launch

1. Open `$APP`. **No Keychain dialog should appear**: the copy silently creates its own `Codey Storage Key` item. If any Keychain dialog appears (other than the single signing "Always Allow" above), click **Deny**, quit and go to Rollback. Keep the login keychain unlocked; even a metadata query prompts when it is locked (`builder/KEYCHAIN.md`).
2. Sign in. The copy has its own `userData`, so a fresh login is needed, and the callback must complete in the copy; if the stock app opens instead, stop. Writes land in `$OWL`, not in `$CM_ROOT/profiles/default/userData`.
3. Existing history, settings and attachments open, and a new thread works. Quit and reopen: still signed in, no dialog.
4. Install mods from Adjustments (in Settings, General page).

## 4. Computer Use

Turn it on in the copy and grant the macOS permissions it asks for to **"Codex Computer Use"**, the copy's own helper. The helper lives under `$CM_ROOT/profiles/default/computer-use/` and uses the team-matched container `$HOME/Library/Group Containers/<TEAM>.com.openai.sky.CUAServicf`. Grants are tied to your stable signing identity, so they persist across rebuilds. It does not work while the screen is locked (locked use is removed from the copy).

## 5. Update, rebuild and switch candidates

A new candidate is built when the stock app, the adapter pack, the framework version, the loader, the relay or the signing identity changes. A candidate is reused only if its build report records the current inputs.

```bash
cm app status                      # stock build, copy build, candidates
cm app prepare                     # build a candidate for the installed stock build (refreshes the adapter if no pack exists)
cm app apply [--candidate <path>]  # swap: the app quits, the launch symlink is replaced, the app reopens
cm framework install <dir>         # a framework update; `cm framework rollback` returns to the previous version
```

The same actions are in Adjustments (**Prepare ChatGPT \<version\>**). The previous candidate stays as last-known-good until the new one passes the health gate (60 s: window rendered, Host ready, handshake, no fatal event); two unhealthy boots revert automatically. Re-running `cm setup --daily` also rebuilds when an input changed and repoints the launch path.

Because the identity is stable, a rebuild neither re-asks for the Keychain "Always Allow" nor for Computer Use grants. To prove it, make a distinguishable candidate and switch: no dialog, still signed in, Computer Use works.

## 6. The concurrency warning

If the stock app or another Codex app-server is using `~/.codex` when you open the copy, a dialog appears before anything else starts (it appears even in safe mode or with the framework disabled):

- **Quit** (Return or Escape): the copy exits and nothing else starts.
- **Quit the other Codex**: asks each listed process to quit (SIGTERM, up to 5 s). If one survives you can **Force quit** it or cancel. Only processes listed in the dialog are signalled.
- **Continue anyway**: proceeds. When every conflict is a recognizable Codex server, a second dialog offers **Always allow this server**, which remembers its program and arguments in `profile.json`. The stock app can never be trusted this way.

Framework-initiated relaunches (safe mode toggles, LKG restore, app switch, framework update, Host-crash recovery) inherit your last Continue for 10 minutes and do not prompt again. `cm recovery guard list` shows trusted servers and `cm recovery guard untrust <n>` removes one. Decisions are logged in `$CM_ROOT/profiles/default/logs/guard.log`. The safest routine is to quit the stock app and CLI sessions before opening the copy.

## 7. Recovery

Each rung works if the ones above it are broken. All commands work offline unless noted.

| Rung | Command or trigger | Effect |
|---|---|---|
| Quarantine a mod | automatic; `cm mods clear-quarantine <id>` | A faulting mod is disabled until you re-enable it |
| Safe mode | `cm recovery safe on` / `off`; two unhealthy boots; the Adjustments button | Framework and Adjustments run, no third-party mod |
| Last-known-good | `cm recovery lkg` (online) | Restores the LKG framework, mod records and copy; mods whose data no longer matches stay disabled |
| Framework disabled | `cm recovery disable` / `enable` | Passthrough: no Host, the relay runs the real app-server. `safe on` does not clear a `disabled` flag |
| Stock app | open `/Applications/ChatGPT.app` | Always untouched |

`cm recovery lkg` follows the current LKG generation, which a healthy new candidate overwrites. It is not a way back to an older saved target; use `cm app apply --candidate <path>` for that.

## 8. Rollback

Do these in order, stopping when you are back to a good state.

1. **Stop the copy.** Quit it and check `owned`. If a copy-owned process remains (Host, relay, helper), `kill` only those pids. Stop sibling services and any test app-server.
2. **Shared config.** Restore only reviewed changes from `$B/config.toml.pre`. Never restore the whole backed-up `codex-home` over newer conversations.
3. **Back to stock.** Open the stock app. It, its Keychain item and its container are unchanged. The copy's files can stay in place unused.
4. **Back to an earlier copy candidate** instead of stock:
   - Online (preferred): if the framework is disabled, `cm recovery enable`. Open the copy, then `cm app apply --candidate "<older candidate>"`, and confirm `readlink "$APP"` and the running executable (`ps -o command= -p <pid>`) both show it.
   - Offline, when the copy cannot start: `T=$(cat "$B/launch-target.pre")`. If `T` is empty (there was no copy before), `rm "$APP"` (it is only a symlink). Otherwise `ln -sfhn "$T" "$APP"`. Then `cm recovery enable`, `cm recovery safe on`, open the copy, `cm app apply --candidate "$T"` and `cm recovery safe off` once it runs.
5. **Lighter rungs** short of a full rollback: `cm recovery safe on`, or `cm recovery disable`.
6. **Keep for diagnosis:** the Codey Keychain item, `$OWL` and the copy's container. Delete no credentials, and never broaden a stock Keychain ACL.

## 9. Checking that the shared `~/.codex` is untouched

After launches, updates and Computer Use actions:

- `diff "$B/config.toml.pre" ~/.codex/config.toml` shows no change you did not make. The copy must not write `notify`, `mcp_servers.node_repl`, `mcp_servers.cua_repl` or Computer Use keys there, and the bundled plugin cache `.mcp.json` files stay byte-identical.
- `~/.codex/computer-use` and the stock Computer Use container are unchanged; the copy's helper runs with `CODEX_HOME=$CM_ROOT/profiles/default` and writes a private `config.toml` there.
- Five minutes after launch there is no Sparkle, Autoupdate or updater process, and no appcast line in `$OWL` or the profile logs.
- A thread created in the copy appears in the CLI's history, and an existing CLI thread opens in the copy.
- Quit and reopen the copy: no Keychain dialog, still signed in.

## 10. Uninstall

Open Codex Mods Setup and choose **Uninstall…** (quit ChatGPT Mods first). It puts your Dock back as it was before setup (ChatGPT's own tile where the copy's was, or the copy's tile gone), removes `$APP` (only when it is a link into `$CM_ROOT/apps`) and, in `apps`, `framework`, `adapters` and `updates` under `$CM_ROOT`, the entries the framework makes there (built copies, framework versions, adapter packs, update staging); anything else stays. Your mods, their data and settings (`store` and `profiles`), `~/.codex` and every backup stay, so setting up again brings your mods back; delete `$CM_ROOT` yourself to remove them too. The copy's own user data (`$OWL`) stays as well.
