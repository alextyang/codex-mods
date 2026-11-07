// The framework's own types (docs/graph/07-framework.md, docs/design/systems.md S1, S2): the framework, its installed mods, its operations,
// the feature log and the copy's update. One definition per card, with the same builders a mod uses (define.mjs); conventions are the
// native library's (native/threads.mjs). What is particular to these cards:
// - CodexMods is one instance; CodexMods.mods is written in the user's order (not an inverse, which would lose it), with Mod.codexMods.
// - Mod.operations and Mod.features are the inverses of Operation.mod and Feature.mods' source (Mod.features is written, Feature.mods is its
//   inverse); Feature.neededBy is the inverse of Feature.needs.
// - CopyUpdate extends the native Update (02): it keeps its operations, its relation to the App and its states, and adds its own.
// - Permission is a value: a field of Mod's state.
import { defineConcept, defineSubtype, ev, op, r, s } from './define.mjs';
import { Update } from './native/app.mjs';

const OPERATION = r.one('Operation');

export const CodexMods = defineConcept('CodexMods', {
  state: {
    version: s.string(),
    safeMode: s.boolean(),
    updatePolicy: s.enum('offer', 'auto'),
    lastKnownGood: s.object({ app: s.string(), framework: s.string(), at: s.time() }).optional(),
    previousVersion: s.string().optional(), // the framework version before the current one (what last-known-good or a revert may bring back)
    lastChecked: s.time().optional(),   // E6.3: when updates were last looked for
    checkProblem: s.string().optional(),   // E6.3: why the last look could not complete (a source that cannot be reached)
    developerMode: s.boolean(),   // framework-ui.md F12: folder installs allowed and stacks shown
  },
  relations: {
    mods: r.many('Mod'),
    operations: r.many('Operation'),
    update: r.maybe('CopyUpdate'),
    features: r.many('Feature'),
    app: r.one('App'),
  },
  operations: {
    install: op({ args: [s.string()], returns: OPERATION }), // a Path: a package file, or a folder (a development package, in developer mode)
    installFromGitHub: op({ args: [s.string()], returns: OPERATION }).optional(),   // F10: owner/repository: its latest release's signed package
    setDeveloperMode: op({ args: [s.boolean()] }).optional(),   // F12
    setModOrder: op({ args: [s.list(s.ref('Mod'))] }).optional(),
    setUpdatePolicy: op({ args: [s.enum('offer', 'auto')] }).optional(),
    enterSafeMode: op({ returns: OPERATION }),
    leaveSafeMode: op({ returns: OPERATION }),
    restoreLastKnownGood: op({ returns: OPERATION }),
    checkForUpdates: op().optional(),
  },
  events: { changed: ev() },
  summary: { title: 'version' },
});

export const Mod = defineConcept('Mod', {
  state: {
    name: s.string(),
    version: s.string(),
    status: s.enum('pendingConsent', 'enabled', 'disabled', 'quarantined'),
    // docs/design/framework-ui.md F5: what it is now, one projection of the facts beside it, the first that holds
    state: s.enum('reloading', 'consent', 'missing', 'incompatible', 'stopped', 'off', 'on'),
    new: s.boolean(),   // installed since Codex started and its page not yet opened
    compatibility: s.enum('compatible', 'degraded', 'atRisk', 'blocked'),
    reasons: s.list(s.string()),
    development: s.boolean(),
    // F8: the framework's words and risk; the mod's own label and detail; an optional one with the user's decision and what it may be; `enforced` false for what nothing enforces
    permissions: s.list(s.object({ id: s.string(), text: s.string(), risk: s.enum('high', 'medium', 'low'), granted: s.boolean(), optional: s.boolean().optional(), enforced: s.boolean().optional(),
      label: s.string().optional(), detail: s.string().optional(), decision: s.enum('allow', 'ask', 'deny').optional(), choices: s.list(s.enum('allow', 'ask', 'deny')).optional() })),
    publisher: s.string().optional(),
    description: s.string().optional(),
    // F6: what the mod says of itself; `author` is its own claim, never an identity
    author: s.string().optional(),
    glyph: s.string().optional(),
    about: s.list(s.string()),
    media: s.list(s.object({ id: s.string(), caption: s.string().optional(), aspect: s.string().optional() })),   // Mod.image gives each
    testedWith: s.list(s.string()),
    installedAt: s.time().optional(),
    // F13: where its rules say it presents, each once: declared placements, not where it drew; F15: whether its stop has been looked at (its page opened since)
    places: s.list(s.object({ kind: s.string(), presentation: s.string().optional(), slot: s.string().optional() })),
    stopSeen: s.boolean().optional(),
    // GOAL.md goal 16: the model use its manifest declares (why, and the other kinds of tool it would like); the switch is mod intelligence's
    intelligence: s.object({ why: s.string(), tools: s.list(s.string()) }).optional(),
    // F10: where it came from; a newer GitHub release a check found, with what it adds and whether it runs here; why its last check could not complete
    source: s.object({ kind: s.enum('github', 'folder', 'file'), repo: s.string().optional(), tag: s.string().optional(), digest: s.string().optional(), path: s.string().optional() }).optional(),
    release: s.object({ version: s.string(), notes: s.string(), addedPermissions: s.list(s.string()), verdict: s.enum('compatible', 'degraded', 'atRisk', 'blocked'),
      publisherChange: s.boolean().optional(), repoChange: s.object({ from: s.string(), to: s.string() }).optional() }).optional(),
    checkProblem: s.string().optional(),
    availableVersion: s.string().optional(),
    quarantine: s.object({ reason: s.string(), at: s.time() }).optional(),
    lastFault: s.object({ at: s.time(), message: s.string(), where: s.string(), stack: s.string().optional() }).optional(),   // F9: kept, so a restart does not lose what stopped it
    // E6 (systems.md "E6 in detail"): what runs beside what is stored, and what the pages offer
    running: s.boolean(),   // it runs now (an enabled mod does not in safe mode or while it stops)
    problem: s.string().optional(),   // why its package cannot be read (the Mod is then its record alone)
    versions: s.list(s.object({ version: s.string(), codeOnly: s.boolean(), withData: s.boolean() })),   // the kept versions it can go back to
    keptData: s.list(s.object({ generation: s.string(), at: s.time(), version: s.string().optional(), bytes: s.number() })),   // to reattach
    dataBytes: s.number(),
    faults: s.number(),
    consentRequest: s.object({
      id: s.string(), kind: s.enum('install', 'update'), version: s.string(), publisher: s.string().optional(),
      permissions: s.list(s.string()), addedPermissions: s.list(s.string()), publisherChange: s.object({ from: s.string(), to: s.string() }).optional(),
      repoChange: s.object({ from: s.string(), to: s.string(), another: s.boolean() }).optional(),
      source: s.object({ repo: s.string(), tag: s.string(), digest: s.string() }).optional(),   // F10: the GitHub release it is for
    }).optional(),   // while something waits: Mod.consent names it
    // every value stored at a project or a thread, as stored: its scope (a Project's or a Thread's ref), `seen` (that scope is in the graph),
    // `valid` (its key still declared, its scope still allowed, its value still valid); cleared only by the user (clearOverrides)
    storedOverrides: s.list(s.object({ key: s.string(), kind: s.enum('project', 'thread'), scope: s.json(), value: s.json(), seen: s.boolean(), valid: s.boolean() })),
    // public-hooks.md §3.9: what it may do without asking (mod.json `automatic`), each off until the user turns it on (on only while it is on)
    automatic: s.list(s.object({ id: s.string(), operation: s.string(), why: s.string(), perHour: s.number(), where: s.json().optional(), args: s.json().optional(), on: s.boolean() })),
    // public-hooks.md §3.7: its policies (ctx.graph.policy) as it registered them, each with the user's switch
    policies: s.list(s.object({ id: s.string(), title: s.string(), spec: s.json(), on: s.boolean() })),
    // public-hooks.md §3.16: what it gives the agent now: its tools, the names of its skills, its instructions (a text, or per turn)
    agent: s.object({ tools: s.list(s.object({ name: s.string(), description: s.string() })), skills: s.list(s.string()), instructions: s.list(s.enum('text', 'perTurn')) }),
  },
  relations: {
    operations: r.many('Operation').inverse('mod'),
    settings: r.maybe('SettingsSection'),
    features: r.many('Feature'),
    codexMods: r.one('CodexMods'),
  },
  operations: {
    consent: op({ args: [s.string(), s.boolean(), s.boolean().optional(), s.list(s.string()).optional()], returns: OPERATION }),   // the request reviewed, approve, enable (an install's), the optional permissions allowed now (F8)
    enable: op({ returns: OPERATION }),
    disable: op({ returns: OPERATION }),
    clearQuarantine: op({ returns: OPERATION }),
    reload: op({ returns: OPERATION }),   // F5: stops and starts it as one operation, clearing a quarantine and keeping every choice
    setPermission: op({ args: [s.string(), s.enum('allow', 'ask', 'deny')], returns: OPERATION }),   // F8: one optional permission's decision
    applyUpdate: op({ returns: OPERATION }).optional(),   // F10: the update a check found for it
    image: op({ args: [s.string()], returns: s.string() }),   // F6: one of its media's images, as a data URL
    markSeen: op({}),   // its page was opened: it is no longer new
    activity: op({ args: [s.object({ after: s.string().optional() }).optional()], returns: s.json() }),   // F9: its feed since Codex started, with a cursor; says when lines were dropped
    update: op({ args: [s.string()], returns: OPERATION }), // a Path
    rollback: op({ args: [s.string(), s.boolean()], returns: OPERATION }), // the version, and whether to restore its data
    setAutomatic: op({ args: [s.string(), s.boolean()], returns: OPERATION }), // an automatic action's id, on or off (the user's)
    setPolicy: op({ args: [s.string(), s.boolean()], returns: OPERATION }), // one of its policies' id, on or off (the user's)
    remove: op({ args: [s.boolean()], returns: OPERATION }), // keep its data
    reattach: op({ args: [s.string().optional()], returns: OPERATION }).optional(), // a kept generation; the newest when absent
    clearOverrides: op({ args: [s.list(s.object({ key: s.string(), scope: s.json() })).optional()], returns: OPERATION }).optional(), // some of the stored overrides; all when absent
  },
  events: { changed: ev(), activity: ev() },   // activity: its feed has new lines, read again
  summary: { title: 'name', subtitle: 'version', status: 'status' },
});

export const Operation = defineConcept('Operation', {
  state: {
    kind: s.enum('install', 'consent', 'enable', 'disable', 'configure', 'update', 'rollback', 'remove', 'reattach', 'clearQuarantine', 'reload', 'setPermission',
      'setAutomatic', 'setPolicy', 'frameworkUpdate', 'appPrepare', 'appSwitch', 'copyUpdate', 'safeMode', 'lastKnownGood'),
    outcome: s.enum('running', 'succeeded', 'failed', 'reverted', 'needsAttention'),
    phase: s.string().optional(),
    startedAt: s.time(),
    endedAt: s.time().optional(),
    message: s.string().optional(),
    waitingFor: s.enum('consent').optional(),
    acknowledgedAt: s.time().optional(), // a needs-attention operation the user acknowledged
  },
  relations: {
    mod: r.maybe('Mod'),
    codexMods: r.one('CodexMods'),
  },
  operations: { acknowledge: op() },   // E6: a needs-attention operation acknowledged (refused for any other outcome)
  events: { progressed: ev(), finished: ev() },
  summary: { title: 'kind', status: 'outcome', time: 'startedAt' },
});

export const Feature = defineConcept('Feature', {
  state: {
    kind: s.enum('feature', 'mechanic'),
    title: s.string(),
    version: s.string(),
    status: s.enum('present', 'changed', 'missing', 'unknown'),
  },
  relations: {
    needs: r.many('Feature'),
    neededBy: r.many('Feature').inverse('needs'),
    mods: r.many('Mod').inverse('features'),
  },
  summary: { title: 'title', status: 'status' },
});

const part = s.object({ from: s.string(), to: s.string() });

export const CopyUpdate = defineSubtype(Update, 'CopyUpdate', {
  state: {
    build: part.optional(), // the app's build (Update.app is the App itself)
    framework: part.optional(),
    mods: s.list(s.object({ mod: s.ref('Mod'), from: s.string(), to: s.string(), addedPermissions: s.list(s.string()) })),
    plan: s.string().optional(), // the hash of its inputs; absent until it is prepared
    held: s.boolean(),
    risks: s.list(s.object({ mod: s.ref('Mod'), feature: s.ref('Feature').optional(), sentence: s.string() })),
    checked: s.enum('static', 'run'),
    problem: s.string().optional(), // why it could not be prepared
    dismissed: s.boolean(), // Later: offered without asking again until it changes
    // framework-ui.md F11: the step it prepares (while it does); the framework's support for the build, from explicit outcomes; whether the automatic
    // policy applies it at the next launch, and why not; how its last try ended when it did not succeed
    step: s.string().optional(),
    support: s.object({ status: s.enum('notChecked', 'checking', 'ships', 'already', 'notYet', 'unknown'), listed: s.boolean().optional(), problem: s.string().optional() }).optional(),
    automatic: s.object({ will: s.boolean(), why: s.enum('off', 'tried', 'dismissed', 'notReady', 'held').optional() }).optional(),
    lastApply: s.object({ outcome: s.enum('failed', 'reverted', 'needsAttention'), at: s.time(), note: s.string().optional() }).optional(),
    // every installed mod on the build it runs (now) and on the candidate (after): what it uses, what of that changed, a newer version that fixes it
    verdicts: s.list(s.object({ mod: s.ref('Mod'), version: s.string(), on: s.boolean(), now: s.enum('compatible', 'degraded', 'atRisk', 'blocked'),
      after: s.enum('compatible', 'degraded', 'atRisk', 'blocked'), unknown: s.boolean(), tested: s.boolean(), uses: s.list(s.string()), changed: s.list(s.string()), missing: s.list(s.string()), unchecked: s.list(s.string()),
      candidate: s.object({ version: s.string(), after: s.enum('compatible', 'degraded', 'atRisk', 'blocked'), addedPermissions: s.list(s.string()), from: s.enum('release', 'github') }).optional() })).optional(),
  },
  relations: { codexMods: r.one('CodexMods') },
  operations: {
    installAnyway: op({ args: [s.string()], returns: OPERATION }), // the held plan the user saw; its held mods are left disabled
    // E6: the plan the user saw, whether to apply it although held, and the mods whose update asks more that the user consents to
    // (additive: Update.install keeps the base's meaning, the ready current plan)
    apply: op({ args: [s.string(), s.boolean(), s.list(s.ref('Mod'))], returns: OPERATION }),
    openOriginal: op({}).optional(),   // F11: the original Codex opened (it updates itself; the mods stay in this copy)
  },
});

/** Every framework definition, a concept before each of its subtypes (Update is the native library's). */
export const FRAMEWORK_TYPES = Object.freeze([CodexMods, Mod, Operation, Feature, CopyUpdate]);
