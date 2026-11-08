// Mux addition 7, method classes (docs/design/runtime-core.md R15). Every client request of the build's app-server protocol has a class:
//   effect      'read'      only observes: lists, reads, gets, status, search, config and schema reads. No effect on Codex or on the outside world, even when
//                           the answer comes from a network call (rate limits, plugin catalogs).
//               'mutate'    changes Codex state (threads, projects, settings, config, queues, subscriptions) and nothing outside Codex.
//               'external'  has an effect outside Codex state: model traffic, a process or terminal, a file-system write, a login or OAuth flow, the git or
//                           plugin network, a message or e-mail, a billed credit, a remote-control or remote-sharing change. When in doubt, a method is
//                           'external' rather than 'mutate'.
//   secret      its params or result carry credentials or tokens (the superset of observers.mjs SECRET_METHODS): the boot ring keeps its place in the stream
//               but never its content.
//   replaySafe  sending the same request twice has the same effect as sending it once. True for every 'read', for setters to a given value, for removals
//               of a given id, and for resume/unsubscribe. False for anything that creates, starts, sends, appends or counts. Every 'external' method is
//               false: a model call, a process or a login is never repeated blindly (AGENTS.md "Uncertain outcomes"). The exceptions are the three
//               methods that carry a required client-generated idempotency key for exactly this purpose (`project/create`, `project/import`,
//               `account/rateLimitResetCredit/consume`); a replay must reuse the original params.
// The table is explicit, one line per method, so a reviewer sees each decision. method-classes.test.mjs checks it against the newest build's schema
// (stable and experimental bundles): a method the build adds fails the test until it is classified here, and an entry the build lacks is flagged.
// Only client requests are classified; notifications and server requests are not. Node built-ins only (none needed).

/** @typedef {'read' | 'mutate' | 'external'} MethodEffect */
/** @typedef {{ readonly effect: MethodEffect, readonly secret: boolean, readonly replaySafe: boolean }} MethodClass */

/** @type {(effect: MethodEffect, replaySafe: boolean) => MethodClass} */
const rec = (effect, replaySafe) => Object.freeze({ effect, secret: false, replaySafe });
/** @type {(c: MethodClass) => MethodClass} */
const secret = (c) => Object.freeze({ ...c, secret: true });

const READ = rec('read', true);
/** Changes Codex state to a given value, or removes a given thing: a second identical call leaves the same state. */
const SET = rec('mutate', true);
/** Changes Codex state by creating, appending or counting: a second call would differ. */
const MUTATE = rec('mutate', false);
/** An effect outside Codex state; never replayed blindly. */
const EXTERNAL = rec('external', false);

/** @type {Readonly<Record<string, MethodClass>>} */
export const METHOD_CLASSES = Object.freeze({
  // --- connection and diagnostics
  'initialize': MUTATE, // per connection: a second one on the same connection is rejected; the mux sends its own to each backend
  'server/diagnostics': READ,

  // --- userVerification: a local credential in the OS secure store, used to sign challenges
  'userVerification/status': READ, // local readiness only, never prompts
  'userVerification/enroll': EXTERNAL, // creates or reuses the OS credential
  'userVerification/delete': EXTERNAL,
  'userVerification/verify': secret(EXTERNAL), // prompts the user and returns a signature (a proof of presence), fresh each time
  'userVerification/cancel': EXTERNAL, // cancels a native prompt

  // --- thread lifecycle
  'thread/start': MUTATE, // creates a thread; no model traffic until turn/start
  'thread/resume': SET, // loads the thread and subscribes this connection; repeating it is harmless
  'thread/fork': MUTATE, // creates a thread
  'thread/archive': SET,
  'thread/unarchive': SET,
  'thread/delete': SET, // by id
  'thread/unsubscribe': SET,
  'thread/revert': SET, // drops turns from a given turn id on; a replay finds the turn gone and changes nothing more
  'thread/inject_items': MUTATE, // appends raw items to the history without a turn
  'thread/increment_elicitation': MUTATE, // counter
  'thread/decrement_elicitation': MUTATE, // counter
  'thread/prediction/request': EXTERNAL, // asks for a next-prompt prediction; assumed to be model traffic (not documented in the schema)
  'thread/approveGuardianDeniedAction': MUTATE, // records an approval of an action the guardian denied; whether it re-runs the action is not in the schema
  'thread/guardianReview': EXTERNAL, // (25679, experimental) the guardian's assessment of the thread's pending action, a model call; it also subscribes the
  //   connection to the thread, which the mux does not record (only thread/start, resume, fork and turn/start do): the app itself does not call it

  // --- thread settings and metadata
  'thread/name/set': SET,
  'thread/metadata/update': SET,
  'thread/settings/update': SET,
  'thread/memoryMode/set': SET,
  'thread/section/move': SET,
  'thread/readState/update': SET, // revision-guarded read/unread marker
  'thread/goal/set': MUTATE, // may restart goal tracking (usage counters) and let the goal continue on its own; not assumed idempotent
  'thread/goal/get': READ,
  'thread/goal/clear': SET,

  // --- thread queue (messages queued to send after the current turn)
  'thread/queue/add': MUTATE,
  'thread/queue/list': READ,
  'thread/queue/update': SET, // by queued submission id
  'thread/queue/delete': SET,
  'thread/queue/reorder': SET,
  'thread/queue/start': EXTERNAL, // starts a turn from a queued message: model traffic

  // --- thread attachments
  'thread/attachment/add': SET, // keyed by identityKey; the response reports the outcome (added or already present)
  'thread/attachment/list': READ,
  'thread/attachmentOwner/list': READ,
  'thread/attachment/remove': SET,

  // --- thread reads and search
  'thread/list': READ,
  'thread/search': READ,
  'thread/searchOccurrences': READ,
  'thread/loaded/list': READ,
  'thread/read': READ,
  'thread/memory/read': READ,
  'thread/sample': EXTERNAL, // a model call: the thread sampled with a prompt
  'thread/sample/cancel': EXTERNAL, // cancels that model call (never replayed blindly)
  'thread/turns/list': READ,
  'thread/items/list': READ,
  'thread/items/read': READ,
  'thread/timeline/list': READ,

  // --- thread work that reaches outside Codex
  'thread/compact/start': EXTERNAL, // compaction is a model call
  'thread/shellCommand': EXTERNAL, // runs a shell command
  'thread/backgroundTerminals/list': READ,
  'thread/backgroundTerminals/clean': EXTERNAL, // ends terminal processes
  'thread/backgroundTerminals/terminate': EXTERNAL,

  // --- realtime (voice) session: an open, billed model connection
  'thread/realtime/start': EXTERNAL,
  'thread/realtime/appendAudio': EXTERNAL,
  'thread/realtime/appendText': EXTERNAL,
  'thread/realtime/appendSpeech': EXTERNAL,
  'thread/realtime/stop': EXTERNAL,
  'thread/realtime/listVoices': READ,

  // --- turns and review: model traffic
  'turn/start': EXTERNAL,
  'turn/steer': EXTERNAL,
  'turn/settings/update': SET,
  'turn/interrupt': SET, // interrupting an interrupted turn is a no-op
  'review/start': EXTERNAL,

  // --- memory and rollouts
  'memory/status': READ,
  'memory/reset': MUTATE, // wipes memory; a replay would wipe what was learned in between
  'rollout/compress': SET, // background pass over cold rollouts in the Codex home; maintenance locks make a repeat a no-op

  // --- projects and thread sections (the sidebar's organization)
  'project/list': READ,
  'project/read': READ,
  'project/create': rec('mutate', true), // required idempotencyKey: a retry with the same key creates nothing more
  'project/import': rec('mutate', true), // required idempotencyKey
  'project/update': SET,
  'project/move': SET,
  'project/delete': SET,
  'threadSection/list': READ,
  'threadSection/create': MUTATE,
  'threadSection/update': SET,
  'threadSection/delete': SET,

  // --- skills and hooks
  'skills/list': READ,
  'skills/extraRoots/set': SET,
  'skills/config/write': SET,
  'hooks/list': READ,

  // --- marketplaces and plugins
  'marketplace/add': EXTERNAL, // clones from the network
  'marketplace/remove': SET, // removes the local copy
  'marketplace/upgrade': EXTERNAL, // fetches from the network
  'plugin/list': READ,
  'plugin/search': READ,
  'plugin/installed': READ,
  'plugin/read': READ,
  'plugin/skill/read': READ,
  'plugin/reconcile': EXTERNAL, // syncs with the remote plugin service and materializes plugins locally
  'plugin/install': EXTERNAL, // downloads; may start an app authorization
  'plugin/uninstall': SET,
  'plugin/share/list': READ,
  'plugin/share/save': EXTERNAL, // publishes a plugin to the remote service
  'plugin/share/updateTargets': EXTERNAL, // changes who can open a remote plugin
  'plugin/share/checkout': EXTERNAL, // downloads a shared plugin
  'plugin/share/delete': EXTERNAL, // deletes the remote share

  // --- apps (connectors)
  'app/read': READ,
  'app/list': READ,
  'app/installed': READ,

  // --- file system: reads are reads; any write is outside Codex state
  'fs/readFile': READ,
  'fs/getMetadata': READ,
  'fs/readDirectory': READ,
  'fs/writeFile': EXTERNAL,
  'fs/createDirectory': EXTERNAL,
  'fs/remove': EXTERNAL,
  'fs/copy': EXTERNAL,
  'fs/watch': MUTATE, // registers a watcher for this connection; a duplicate watchId may be rejected
  'fs/unwatch': SET,
  'fuzzyFileSearch': READ,
  'fuzzyFileSearch/sessionStart': MUTATE, // opens a search session
  'fuzzyFileSearch/sessionUpdate': SET,
  'fuzzyFileSearch/sessionStop': SET,

  // --- commands and processes
  'command/exec': EXTERNAL,
  'command/exec/write': EXTERNAL,
  'command/exec/terminate': EXTERNAL,
  'command/exec/resize': EXTERNAL,
  'process/spawn': EXTERNAL,
  'process/writeStdin': EXTERNAL,
  'process/kill': EXTERNAL,
  'process/resizePty': EXTERNAL,

  // --- models and capabilities
  'model/list': READ,
  'modelProvider/capabilities/read': READ,
  'collaborationMode/list': READ,
  'permissionProfile/list': READ,
  'experimentalFeature/list': READ,
  'experimentalFeature/enablement/set': SET,
  'mock/experimentalMethod': READ, // test-only echo

  // --- config
  'config/read': READ,
  'configRequirements/read': READ,
  'config/value/write': SET, // replace or upsert, optionally guarded by expectedVersion
  'config/batchWrite': SET,
  'config/mcpServer/reload': SET, // re-reads the MCP server config; servers refresh later

  // --- MCP servers
  'mcpServerStatus/list': READ,
  'mcpServer/resource/read': READ,
  'mcpServer/tool/call': EXTERNAL, // runs a tool on a server: any effect
  'mcpServer/event/stream/start': EXTERNAL, // calls a tool that streams events
  'mcpServer/event/stream/stop': EXTERNAL,
  'mcpServer/oauth/login': secret(EXTERNAL), // result carries the authorization URL

  // --- environments (execution environments, local or remote)
  'environment/add': secret(SET), // stores a remote environment by id, with an optional bearer token for the executor
  'environment/info': READ,
  'environment/status': READ,

  // --- remote control (driving this app from another device)
  'remoteControl/enable': EXTERNAL, // connects to the remote service
  'remoteControl/disable': EXTERNAL,
  'remoteControl/status/read': READ,
  'remoteControl/pairing/start': secret(EXTERNAL), // result carries the pairing code
  'remoteControl/pairing/status': secret(READ), // params carry the pairing code
  'remoteControl/client/list': READ,
  'remoteControl/client/revoke': EXTERNAL,

  // --- account and login
  'account/read': READ,
  'account/login/start': secret(EXTERNAL), // API key, auth tokens, auth URL, device code
  'account/login/cancel': EXTERNAL,
  'account/logout': SET, // clears the stored credentials; whether it also revokes remotely is not in the schema
  'account/gatewayOAuth/read': READ, // "never contains credentials"
  'account/gatewayOAuth/login': secret(EXTERNAL),
  'account/gatewayOAuth/cancel': EXTERNAL,
  'account/bedrock/discover': READ, // names of local AWS profiles and credential sources, no secrets
  'account/bedrock/setup': secret(EXTERNAL), // resolves AWS credentials, which can run a login helper
  'account/bedrock/checkGovCloudRequirements': READ,
  'account/gcp/setup': EXTERNAL, // sets up GCP from a credential file's path, a project and a location; carries no credential itself (its result is empty)
  'accountSession/list': READ, // the signed-in account sessions (names, e-mails, workspaces); no credentials
  'accountSession/switch': EXTERNAL, // changes the active account session, and may start a browser login (allowBrowserLogin)
  'account/rateLimits/read': READ,
  'account/usage/read': READ,
  'account/workspaceMessages/read': READ,
  'account/rateLimitResetCredit/consume': rec('external', true), // spends a credit; required idempotencyKey makes a retry with the same key safe
  'account/sendAddCreditsNudgeEmail': EXTERNAL,
  'feedback/upload': EXTERNAL,
  'feedback/save': EXTERNAL, // writes a feedback bundle (logs included) to a path on disk

  // --- external agent config (importing another agent's setup)
  'externalAgentConfig/detect': READ,
  'externalAgentConfig/import': MUTATE, // writes config and sessions into Codex; the source is untouched
  'externalAgentConfig/import/recordHistory': MUTATE,
  'externalAgentConfig/import/readHistories': READ,

  // --- Windows sandbox
  'windowsSandbox/setupStart': EXTERNAL,
  'windowsSandbox/readiness': READ,
});

/**
 * The class of a client request method, or null for a method that is not in the table (a new build's method, or not a client request at all).
 * @param {string} method
 * @returns {MethodClass | null}
 */
export function classOf(method) {
  return typeof method === 'string' && Object.hasOwn(METHOD_CLASSES, method) ? METHOD_CLASSES[method] : null;
}
