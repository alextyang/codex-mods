# 07 The framework

The framework's own objects: the mods installed in this copy of the app, what they may do, the changes the framework makes, the feature
log and the copy's updates. They are graph types like the app's (README rule 6: "built the same way"), in the same runtime, presented by
the same presentation types (03), with one difference of authority: they are the user's. No mod acts on them or intercepts their
operations (docs/design/systems.md S4; graph-boundary.md B5). Their operations are the framework's lifecycle operations
(ARCHITECTURE.md §11, §12): each returns its Operation at once, and the Operation's outcome follows.

Card format and tiers are 02's. The feature index of these types is below, in the form of 01.

## F15 The framework

| Feature | Types | Presentations |
|---|---|---|
| See the installed mods, in your order, with their status and compatibility; change the order | CodexMods, Mod | SettingsPage, SettingsRow |
| Install a mod, see what it may do, consent; enable, disable, clear a quarantine | CodexMods, Mod, Permission, Operation | SettingsPage, Dialog, NotificationBanner |
| Update a mod, roll it back, remove it (keeping or deleting its data), reattach kept data | Mod, Operation | SettingsPage, Dialog |
| Follow what the framework is doing and what needs your attention | Operation | SettingsRow, NotificationBanner |
| See what the framework and the mods rely on, and what a new build of the app changes | Feature, Mod | SettingsRow, Dialog |
| Update the copy (a new app build, a new framework version, the mods' updates) once it is checked, or hold it | CopyUpdate, Update, Mod, Feature | NotificationBanner, Dialog, SettingsPage |
| Recover: safe mode, the last known good state | CodexMods, Operation | SettingsPage, NotificationBanner, Dialog |

---

## CodexMods                                       concept (one instance)
Purpose     The modding framework in this copy of the app.
Identity    one per installation
State       version: string · safeMode: boolean · updatePolicy: offer | auto · lastKnownGood?: { app: string, framework: string, at: Time }
            · previousVersion?: string (the framework version before this one) · lastChecked?: Time (when updates were last looked for)
            · checkProblem?: string (why the last look could not complete) · developerMode: boolean (folder installs allowed and stacks shown)
Operations  install(source: Path) → Operation (a package file, or a folder: a development package, in developer mode) · installFromGitHub?(repo: string) → Operation
            (owner/repository: its latest release's signed .codexmod) · setDeveloperMode?(on: boolean) · setModOrder?(mods: Ref[]) · setUpdatePolicy?(policy) · enterSafeMode() → Operation
            · leaveSafeMode() → Operation · restoreLastKnownGood() → Operation · checkForUpdates?()
Events      changed
Relations   mods: Mod (*) (in your order) · operations: Operation (*) · update: CopyUpdate (0..1) · features: Feature (*) · app: App (1)
Extension   attach · decorate
Presented   SettingsPage (the Mods section) · NotificationBanner (safe mode) · Dialog
Notes       There is one. Its operations are yours: no mod invokes or intercepts them.

## Mod                                             concept
Purpose     A mod installed in the framework.
Identity    id
State       name: string · version: string · status: pendingConsent | enabled | disabled | quarantined · compatibility: compatible | degraded
            | atRisk | blocked · reasons: [string] (one sentence each: what is missing or changed) · development: boolean
            · permissions: [Permission] · publisher?: string (its key's fingerprint) · description?: string · availableVersion?: string
            · quarantine?: { reason: string, at: Time } · running: boolean (it runs now: an enabled mod does not in safe mode)
            · problem?: string (its package cannot be read: the Mod is its record alone) · versions: [{ version: string, codeOnly:
            boolean, withData: boolean }] (the kept versions it can go back to, and how) · keptData: [{ generation: string, at: Time,
            version?: string, bytes: number }] (data kept by a removal, to reattach) · dataBytes: number · faults: number
            · state: reloading | consent | missing | incompatible | stopped | off | on (what it is now, one projection of the facts beside it, the first that holds)
            · new: boolean (installed since Codex started, its page not yet opened) · author?: string (its own claim, never an identity) · glyph?: string · about: [string]
            · media: [{ id: string, caption?: string, aspect?: string }] · testedWith: [string] · installedAt?: time
            · places: [{ kind: string, presentation?: string, slot?: string }] (where its rules say it presents, each once: declared, not where it drew)
            · stopSeen?: boolean (its stop has been looked at: its page opened since it stopped)
            · source?: { kind: github | folder | file, repo?: string, tag?: string, digest?: string, path?: string } (where it came from: the signature is its identity,
            the repository only where to look) · release?: { version: string, notes: string, addedPermissions: [string], verdict: compatible | degraded | atRisk
            | blocked, publisherChange?: boolean, repoChange?: { from: string, to: string } } (a newer GitHub release a check found) · checkProblem?: string (why its last
            check could not complete)
            · consentRequest?: { id: string, kind: install | update, version: string, publisher?: string, permissions: [string],
            addedPermissions: [string], publisherChange?: { from: string, to: string }, repoChange?: { from: string, to: string, another: boolean },
            source?: { repo: string, tag: string, digest: string } } (what waits for your consent; repoChange: an update from a repository renamed or moved, or
            another one; source: the GitHub release it is for)
            · storedOverrides: [{ key: string, kind: project | thread, scope: Ref (that Project or Thread), value: JSON, seen: boolean,
            valid: boolean }] (every
            value stored at a project or a thread, as stored: `seen` while its scope is in the graph, `valid` while its key is declared,
            its scope allowed and its value valid)
Operations  consent(request: string, approve: boolean, enable?: boolean, allow?: [string]) → Operation (allow: optional permissions allowed from the start) · enable() → Operation · disable() → Operation · clearQuarantine() → Operation
            · setPermission(grant: string, decision: allow | ask | deny) → Operation (one optional permission's decision; a mod running is restarted unless it only gains)
            · applyUpdate?() → Operation (the newer release a check found: the update operation, with consent where it asks more or comes from elsewhere)
            · reload() → Operation (stops and starts it as one operation, clearing a quarantine and keeping every choice) · image(id: string) → string (one of its media's images, as a data URL) · markSeen()
            · update(source: Path) → Operation · rollback(version: string, restoreData: boolean) → Operation
            · remove(keepData: boolean) → Operation · reattach?(generation?: string) → Operation (one operation: a mod that is on is
            turned off, its data reattached, and turned on again) · clearOverrides?(entries?: [{ key: string, scope: Ref }]) → Operation
            (some stored overrides, or all; never judged against the declarations: they are cleared only by your choice)
Events      changed
Relations   operations: Operation (*) · settings: SettingsSection (0..1) (its own section) · features: Feature (*) (what it needs)
            · codexMods: CodexMods (1)
Extension   attach · decorate
Presented   SettingsPage · SettingsRow (the overview) · Dialog (consent, remove) · NotificationBanner (quarantine, an update); no mod's
            rule presents it (docs/design/systems.md "E6 in detail", decision 6)
Notes       A mod reads its own instance without a grant, and sets its own Settings. Everything else on a Mod is yours. A consent names
            the request you reviewed (its id) and is refused once another waits; enable is an install's (an update's consent keeps the
            mod as it is).

## Permission                                      value
Purpose     What a mod may do, in plain words.
State       id: string (the grant) · text: string · risk: high | medium | low · granted: boolean

## Operation                                       concept
Purpose     A change the framework makes: an install, an update, a rollback, a removal, a switch to a new build of the app.
Identity    id
State       kind: install | consent | enable | disable | configure | update | rollback | remove | reattach | clearQuarantine | reload
            | frameworkUpdate | appPrepare | appSwitch | copyUpdate | safeMode | lastKnownGood · outcome: running | succeeded | failed | reverted
            | needsAttention · phase?: string · startedAt: Time · endedAt?: Time · message?: string · waitingFor?: consent
            · acknowledgedAt?: Time
Operations  acknowledge() (one that needs attention: you have seen it; it keeps its outcome)
Events      progressed · finished
Relations   mod: Mod (0..1) · codexMods: CodexMods (1)
Extension   attach · decorate
Presented   SettingsRow (activity) · NotificationBanner (finished, needs attention) · Dialog
Notes       A record you follow; its one operation says you have seen an outcome that needs attention. Needs attention means local
            state is consistent but external effects may have happened; it is told once and never retried.

## Feature                                         concept
Purpose     One entry of the feature log: something the SDK offers, or a part of the app the framework relies on.
Identity    id
State       kind: feature | mechanic · title: string · version: string · status: present | changed | missing | unknown (on this build)
Relations   needs: Feature (*) · neededBy: Feature (*) (the inverse) · mods: Mod (*) (the mods that need it, the inverse of Mod.features)
Extension   attach · decorate
Presented   SettingsRow (compatibility) · Dialog (an update's risks)
Notes       It detects risk; it does not prove compatibility (a changed meaning behind an unchanged name is not seen).

## CopyUpdate                                      subtype of Update
Purpose     The update of this copy of the app: a new build of the app, a new framework version, or both, with the mods' updates.
Adds        build?: { from: string, to: string } (the app's build; Update's `app` is the App) · framework?: { from: string, to: string }
            · mods: [{ mod: Mod, from: string, to: string, addedPermissions: [string] }]
            · plan?: string (the hash of its inputs; absent until it is prepared) · held: boolean
            · risks: [{ mod: Mod, feature?: Feature, sentence: string }] · checked: static | run
            · problem?: string (why it could not be prepared: a build the framework cannot make, a release that does not verify)
            · dismissed: boolean (later: offered without asking again until it changes)
            · step?: string (the step it prepares, while it does) · support?: { status: notChecked | checking | ships | already | notYet | unknown,
            listed?: boolean, problem?: string } (the framework's support for the build, from explicit outcomes) · automatic?: { will: boolean,
            why?: off | tried | dismissed | notReady | held } (whether the automatic policy applies it at the next launch) · lastApply?: { outcome:
            failed | reverted | needsAttention, at: Time, note?: string } (how this offer's last try ended, when it did not succeed)
            · verdicts?: [{ mod: Mod, version: string, on: boolean, now: Verdict, after: Verdict, unknown: boolean, tested: boolean, uses: [string],
            changed: [string], missing: [string], unchecked: [string], candidate?: { version: string, after: Verdict, addedPermissions: [string], from: release | github } }] (every
            installed mod on the build it runs and on the candidate, with a newer version that fixes it)
            · installAnyway(plan: string) → Operation (applies a held plan, the one the user saw, leaving its held mods disabled)
            · apply(plan: string, anyway: boolean, consent: [Mod]) → Operation (the plan the user saw, applied although held when anyway,
            with the mods whose update asks more that the user consents to) · openOriginal?() (the original Codex opened)
Relations   codexMods: CodexMods (1)
Notes       Update's operations keep their meaning: download() prepares it in quarantine, install() applies a ready plan as one
            operation (refused when held), later() keeps it offered without asking again until it changes. Its state follows Update's
            (available, downloading while it is prepared, ready, installing until its verdict); held is its own. No mod intercepts or
            replaces its operations: a mod could otherwise stop the update that fixes or removes it (graph-boundary.md B5).
