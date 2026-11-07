// The feature log's declarations per unit (docs/design/systems.md S16, "E4 in detail"), merged over units.mjs by unit id: which of a
// unit's features need which mechanic (`assign`), what is best effort (`prefers`), what the scan cannot see (`needs`, `dynamic`) and
// what no build evidence can check (`unchecked`). Each entry cites the code it reads (file:line). Rules used:
// - a mechanic with no `assign` entry is needed by every feature the unit serves; an operation needs its declaring type's feature, so a
//   mechanic is assigned to the type, not again to its operations, unless only some operations use it;
// - a protocol notification is needed when the type cannot show its instances, state or events without it, and preferred when the code
//   only observes the app's own traffic (`responded`), refreshes (a timer or a read covers it), cleans up, or feeds an optional member;
// - features outside a unit's `serves` are assigned where the code clearly feeds them ("outside serves").
// Written from a scout of the code (2026-10-27) and checked by the generator: an assignment names a mechanic the unit reaches and a
// feature a provider realizes. Node built-ins only (none needed).

// ---------------------------------------------------------------------------------------------------------------- shared lists
const ITEM_TYPES = ['graph:UserMessage', 'graph:Attachment', 'graph:Mention', 'graph:AgentMessage', 'graph:CodexStep', 'graph:CodexReasoning', 'graph:Plan',
  'graph:CodexCommandRun', 'graph:FileEdit', 'graph:Search', 'graph:WebLookup', 'graph:CodexToolCall', 'graph:ComputerAction', 'graph:Delegation'];
const REQUEST_TYPES = ['graph:Approval', 'graph:CodexCommandApproval', 'graph:EditApproval', 'graph:NetworkApproval', 'graph:ToolApproval',
  'graph:ComputerUseApproval', 'graph:CodexQuestion'];

export const DECLS = {
  // ================================================================================================================ the native core
  'core:conversation': {
    // methods without a slash, which the scan does not take for one: index.mjs findFiles, and the reports `error`, `warning` and
    // `guardianWarning` (coreNotification)
    needs: ['protocol:fuzzyFileSearch', 'protocol:error', 'protocol:warning', 'protocol:guardianWarning'],
    assign: {
      'protocol:fuzzyFileSearch': ['graph:Project.findFiles'],
      'protocol:model/rerouted': ['graph:Model', 'graph:CodexTurn'],   // the model a turn runs with (its usage tells its context window); CodexTurn modelRerouted
      // ---- the thread list, the thread's own state and events (index.mjs coreNotification)
      'protocol:thread/list': ['graph:CodexThread'],                   // index.mjs:495 listThreads: the Thread collection
      'protocol:thread/started': ['graph:CodexThread'],                // :608 createdThread (event `created`)
      'protocol:thread/status/changed': ['graph:CodexThread'],         // :611
      'protocol:thread/name/updated': ['graph:CodexThread'],           // :612 (Thread.rename applies its own answer, :108)
      'protocol:thread/archived': ['graph:CodexThread'],               // :613
      'protocol:thread/unarchived': ['graph:CodexThread'],             // :614
      'protocol:thread/deleted': ['graph:CodexThread'],                // :620 removeThread
      'protocol:thread/closed': ['graph:CodexThread'],                 // :615 only an ephemeral thread ends here (cleanup)
      'protocol:thread/goal/updated': ['graph:CodexThread'],           // :625 `goal` is a `supports` member; setGoal/clearGoal apply their answers (:109-110)
      'protocol:thread/goal/cleared': ['graph:CodexThread'],           // :626
      'protocol:thread/tokenUsage/updated': ['graph:CodexThread'],     // `usage` (a `supports` member) and the event tokenUsageReported
      // ---- what the server reports as it happens (graph-integrity G1.3, G1.4): the subtypes' report events and facts
      'protocol:error': ['graph:CodexTurn'],                             // CodexTurn errored {error, willRetry}
      'protocol:turn/diff/updated': ['graph:CodexTurn'],                 // CodexTurn.diff
      'protocol:model/verification': ['graph:CodexTurn'],                // CodexTurn verified
      'protocol:thread/compacted': ['graph:CodexThread'],                // CodexThread compacted
      'protocol:thread/reverted': ['graph:CodexThread'],                 // CodexThread reverted
      'protocol:hook/started': ['graph:CodexThread'],                    // CodexThread hookStarted
      'protocol:hook/completed': ['graph:CodexThread'],                  // CodexThread hookCompleted
      'protocol:guardianWarning': ['graph:CodexThread'],                 // CodexThread guardianWarning
      'protocol:warning': ['graph:CodexThread'], 'protocol:thread/prediction/updated': ['graph:CodexThread'],
      'protocol:item/autoApprovalReview/started': ['graph:CodexTurn'], 'protocol:item/autoApprovalReview/completed': ['graph:CodexTurn'],
      'protocol:autoApprovalReview/strictReviewRequired': ['graph:CodexTurn'], 'protocol:model/safetyBuffering/updated': ['graph:CodexTurn'],
      'protocol:turn/moderationMetadata': ['graph:CodexTurn'],
      // a turn that starts while one of these is open is its client's, else the agent's own (Turn.startedBy, G1.7)
      'protocol:review/start': ['graph:CodexTurn'],
      'protocol:thread/compact/start': ['graph:CodexTurn'],
      // observed traffic of the app's other clients (index.mjs:51 READ_METHODS, :739-742): they put what the answer names
      'protocol:thread/start': ['graph:CodexThread'],                  // :741 createdThread(m.result.thread)
      'protocol:thread/fork': ['graph:CodexThread'],                   // :741
      'protocol:thread/read': ['graph:CodexThread'],                   // :742 putThread
      'protocol:thread/resume': ['graph:CodexThread'],                 // :742 observed answers; :340 withLoadedThread retries a request with it (areas' send, compact, queue/start, settings/update)
      'protocol:thread/revert': ['graph:CodexTurn'],                        // :734,:738 the turns the app cut go (historyEdited)
      'protocol:thread/rollback': ['graph:CodexTurn'],                      // :734,:738
      'protocol:turn/start': ['graph:CodexTurn'],                           // observed: each turn's `trigger` (who started it, H5); unknown without it
      'protocol:thread/search': ['graph:CodexThread'],                 // the provider's own search (H7, public-hooks.md §3.2): content matches
      // ---- turns and their items (loadThread :552, notifications :631-659)
      'protocol:turn/started': ['graph:CodexTurn', 'graph:CodexThread'],    // :631 putTurn; Thread events turnStarted/turnFinished
      'protocol:turn/completed': ['graph:CodexTurn', 'graph:CodexThread'],  // :631
      'protocol:thread/turns/list': ['graph:CodexTurn', ...ITEM_TYPES],     // :552 loadThread, :566 catchUp: the turns and the items in them
      'protocol:item/started': ITEM_TYPES,                             // :640 putItem (every item type map.mjs itemData makes, :294-373)
      'protocol:item/completed': ITEM_TYPES,                           // :648
      'protocol:item/agentMessage/delta': ['graph:AgentMessage'],      // :657 onDelta: streaming text
      'protocol:turn/plan/updated': ['graph:Plan', 'graph:PlanTask'], // :658 putPlan (PlanTask only comes from here)
      'protocol:item/plan/delta': ['graph:Plan'],                      // :402,:663 STEP_DELTAS: the steps of the item say `updated`
      'protocol:item/reasoning/summaryPartAdded': ['graph:CodexReasoning'],
      'protocol:item/reasoning/summaryTextDelta': ['graph:CodexReasoning'],
      'protocol:item/reasoning/textDelta': ['graph:CodexReasoning'],
      'protocol:item/commandExecution/outputDelta': ['graph:CodexCommandRun'],
      'protocol:item/commandExecution/terminalInteraction': ['graph:CodexCommandRun'],
      'protocol:item/fileChange/outputDelta': ['graph:FileEdit'],
      'protocol:item/fileChange/patchUpdated': ['graph:FileEdit'],
      'protocol:item/mcpToolCall/progress': ['graph:CodexToolCall', 'graph:ComputerAction'],   // mcpToolCall items are ToolCall, or ComputerAction on an app (map.mjs:344-364)
      // ---- server requests (map.mjs requestData :410-455; the answers go through the mux, not a method)
      'protocol:item/commandExecution/requestApproval': ['graph:CodexCommandApproval', 'graph:NetworkApproval'],   // map.mjs:415 (a network host makes a NetworkApproval)
      'protocol:item/fileChange/requestApproval': ['graph:EditApproval'],                                       // map.mjs:418
      'protocol:item/permissions/requestApproval': ['graph:Approval', 'graph:NetworkApproval'],                 // map.mjs:420
      'protocol:mcpServer/elicitation/request': ['graph:ToolApproval', 'graph:ComputerUseApproval'],            // map.mjs:425 (also a generic Question: the fallback, not needed)
      'protocol:item/tool/requestUserInput': ['graph:CodexQuestion'],       // map.mjs:439; Question.answer needs it through the type (index.mjs:155)
      'protocol:serverRequest/resolved': REQUEST_TYPES,                // index.mjs:659 onResolved: a request another client answered ends `cancelled`
      // ---- operations
      'protocol:thread/name/set': ['graph:Thread.rename'],             // index.mjs:108
      'protocol:thread/goal/set': ['graph:CodexThread.setGoal'],            // :109
      'protocol:thread/goal/clear': ['graph:CodexThread.clearGoal'],        // :110
      'protocol:turn/interrupt': ['graph:Question.skip'],              // :215 skip interrupts the turn of a requestUserInput question (:157)
      'protocol:model/list': ['graph:Model'],                          // :513
      // ---- other features the module feeds (outside serves)
      'protocol:fs/changed': ['graph:File', 'graph:Folder', 'graph:CodexInstructions', 'graph:ProjectAction'],   // :609 files?.changed, instructions?.changed, actions?.changed
      'protocol:thread/attachment/updated': ['graph:WorktreeEnvironment'],   // :610 worktrees.attachmentUpdated (outside serves)
      'protocol:thread/archive': ['graph:WorktreeEnvironment.remove'],       // :333 the fallback archive of the chats in a worktree being removed (outside serves)
      'protocol:account/updated': ['graph:Account', 'graph:ChatGPTAccount'],            // :660 accounts.notified (it also re-reads the models: a refresh, Model does not need it)
      'protocol:account/login/completed': ['graph:Account', 'graph:ChatGPTAccount'],    // :660
      'protocol:account/rateLimits/updated': ['graph:CodexUsage'],                           // :661 accounts.notified (outside serves)
    },
    prefers: [
      'protocol:thread/closed', 'protocol:thread/goal/updated', 'protocol:thread/goal/cleared', 'protocol:thread/tokenUsage/updated',
      'protocol:thread/start', 'protocol:thread/fork', 'protocol:thread/read', 'protocol:thread/resume', 'protocol:thread/revert', 'protocol:thread/rollback',
      'protocol:turn/start', 'protocol:review/start', 'protocol:thread/compact/start',   // who started a turn reads `unknown` without them
      'protocol:error', 'protocol:turn/diff/updated', 'protocol:model/verification', 'protocol:thread/compacted', 'protocol:thread/reverted',
      'protocol:hook/started', 'protocol:hook/completed', 'protocol:guardianWarning', 'protocol:warning', 'protocol:thread/prediction/updated',
      'protocol:item/autoApprovalReview/started', 'protocol:item/autoApprovalReview/completed', 'protocol:autoApprovalReview/strictReviewRequired',
      'protocol:model/safetyBuffering/updated', 'protocol:turn/moderationMetadata',   // reports: events and optional facts of the subtypes
      'protocol:thread/search',                 // search finds titles without it, not what the chats said
      'protocol:fs/changed',                    // the files, instructions and actions watches are best effort (fs/watch is a prefer in those units)
      'protocol:thread/attachment/updated',     // a refresh of the worktree check
      'protocol:thread/archive',                // a fallback: the threads area's archive is used when it is there (index.mjs:332)
      'protocol:account/rateLimits/updated',    // the usage is also read after each turn and every 5 minutes
      'protocol:model/rerouted',                // feeds an optional member (Model.contextWindow)
    ],
    unchecked: ['JSON-RPC answers to the app-server\'s requests, sent through the mux (Approval.answer, Question.answer and skip)'],
  },

  'core:files': {
    // files.mjs:207 fs/watch (a failed watch is logged and dropped, :208-210), :218 fs/unwatch(...).catch(() => {}): the folder is read without them
    assign: { 'protocol:fs/watch': ['graph:Folder', 'graph:File'], 'protocol:fs/unwatch': ['graph:Folder', 'graph:File'] },
    prefers: ['protocol:fs/watch', 'protocol:fs/unwatch'],
  },
  'core:instructions': {
    // instructions.mjs:143 fs/watch (failure logged), :153 fs/unwatch(...).catch(() => {}); the files are read on a timer and after an edit anyway
    assign: { 'protocol:fs/watch': ['graph:CodexInstructions'], 'protocol:fs/unwatch': ['graph:CodexInstructions'] },
    prefers: ['protocol:fs/watch', 'protocol:fs/unwatch'],
  },
  'core:actions': {
    // actions.mjs:96 fs/watch (failure logged), :106 fs/unwatch(...).catch(() => {}); the actions are read every 2 minutes anyway
    assign: { 'protocol:fs/watch': ['graph:ProjectAction'], 'protocol:fs/unwatch': ['graph:ProjectAction'] },
    prefers: ['protocol:fs/watch', 'protocol:fs/unwatch'],
  },

  'core:app-state': {
    // app-state.mjs:265 feedback/upload is App.sendFeedback only (App.sendFeedback is not in serves: outside serves)
    assign: { 'protocol:feedback/upload': ['graph:App.sendFeedback'] },
  },

  'core:accounts': {
    assign: {
      'protocol:account/read': ['graph:Account', 'graph:ChatGPTAccount', 'graph:CodexUsage'],     // accounts.mjs:103: the account, and the usage that hangs on a ChatGPT account (:142)
      'protocol:account/updated': ['graph:Account', 'graph:ChatGPTAccount'],                 // :184 notified: read again (events signedIn, signedOut, planChanged)
      'protocol:account/login/completed': ['graph:Account', 'graph:ChatGPTAccount', 'graph:Account.signIn'],   // :184; signIn waits for it (outside serves: Account.signIn)
      'protocol:account/rateLimits/read': ['graph:CodexUsage'],                                   // :163
      'protocol:account/rateLimits/updated': ['graph:CodexUsage'],                                // :185 a merge into the usage: it is also read after each turn and every READ_MS
      'protocol:account/login/start': ['graph:Account.signIn'],                              // :207 (outside serves)
      'protocol:account/logout': ['graph:Account.signOut'],                                  // :215 (outside serves)
    },
    prefers: ['protocol:account/rateLimits/updated'],
  },

  // ================================================================================================================ framework-main's modules the core reaches
  'main:projects': {
    // projects.cjs:53 KEYS holds 'local-projects' (the projects), read through the KEYS array, not `.get('...')`; :647 the atom is read as atoms['...']
    needs: ['state:local-projects', 'state:local-env-selections-by-workspace'],
    assign: {
      // ---- the projects themselves (default for 'service:projects' and 'state:local-projects': every op needs `bound`, the project store, :255)
      'state:project-order': ['graph:LocalProject'],                                        // :95 `Array.isArray(...) ? ... : []`: an order, not needed
      'state:selected-project': ['graph:Project.open'],                                       // :109 selectedOf: the `opened` event; Project.open itself is createOrSelectLocalProjects (:289-294)
      'state:thread-project-assignments': ['graph:LocalProject', 'graph:CodexThread'],       // :120 threadFactsOf: which project shows a thread (the cwd rule applies without them)
      'state:projectless-thread-ids': ['graph:LocalProject', 'graph:CodexThread'],           // :128
      'state:thread-workspace-root-hints': ['graph:LocalProject', 'graph:CodexThread'],      // :130
      // ---- files and folders (ops 'list', 'inspect': :392-397), instructions of a project (:380-391)
      'service:workspaceFiles': ['graph:Folder', 'graph:File', 'graph:CodexInstructions', 'graph:Instructions.edit'],   // :395 list/inspect; :384 instructions read; :619 saveText (edit)
      // ---- apps (readApps :407, removeApproval :544, open-in :305)
      'service:openIn': ['graph:ExternalApp', 'graph:Project.openIn', 'graph:Folder.openIn', 'graph:File.openIn',    // :408 getTargets; :308 openIn.open
        'graph:GitRepository', 'graph:Branch', 'graph:Repository.workingChanges',                                                                      // :487-491 readRepository: the git worker (requestGitWorker)
        'graph:WorktreeEnvironment'],                                                                               // :459 readWorktree; Worktree.remove reads it too (:328)
      'service:computerUseSettings': ['graph:ExternalApp.setComputerUse'],                  // :547 removeAppApproval (readApps also reads getAppApprovals, :421, but without it the apps say computerUse `unsupported`)
      // ---- git (:334-356)
      'service:gitRepository': ['graph:Repository.switchBranch', 'graph:Repository.createBranch', 'graph:Repository.push', 'graph:Branch.switch'],   // :339 checkoutBranch, createBranch, push
      'service:repositoryOrigins': ['graph:GitRepository', 'graph:Branch'],                 // :489-497 the root and origin; without it the git worker names the root (:497) -> prefers
      // ---- worktrees (:313-333)
      'service:managedWorktrees': ['graph:WorktreeEnvironment.remove'],                     // :331 delete
      'service:pinnedThreads': ['graph:WorktreeEnvironment.remove'],                        // :586 readPinned: the app refuses to delete a worktree that holds a pinned chat (worktrees.mjs:109)
      'state:git-worktree-root': ['graph:WorktreeEnvironment.remove'],                      // :580 `try { ... } catch { /* the default */ }`, else <Codex home>/worktrees -> prefers
      // ---- project actions (:357-379, :634-672)
      'service:localEnvironments': ['graph:ProjectAction', 'graph:Command.run'],            // :361 envs.list (actions and run-action); WorktreeEnvironment.setup also reads envs.read (:478, optional)
      'state:local-env-selections-by-workspace': ['graph:ProjectAction'],                   // :646-650 `try { ... } catch { /* no selection read: the default */ }` -> prefers
      'service:terminal': ['graph:Command.run', 'graph:Project.newTerminal'],               // openTerminal: create (and runAction for a ProjectAction's run)
      // ---- opening a file or the instructions in a tab (openTab :566; runAction :664)
      'service:appActions': ['graph:File.open', 'graph:Instructions.open', 'graph:Command.run', 'graph:Project.newTerminal'],    // windows.tabs.open
      // ---- global instructions
      'service:agentInstructions': ['graph:Instructions.edit'],                             // :272-274 the global AGENTS.md is written through the app
      // ---- a chat's project (move-thread)
      'service:threadProjectAssignments': ['graph:Thread.moveTo'],                           // setMembership, what the app's "Move to project" writes
      // ---- cloud environments (:517-541) and the pages the module opens (:256-262)
      'service:accountInfo': ['graph:CloudEnvironment'],                                    // :518,:521 readAccountInfo (names the account and user for the list)
      'service:environmentConfigs': ['graph:CloudEnvironment'],                             // :519,:528 list
      'message:navigate-to-route': ['graph:CloudEnvironment.manage'],                       // :260 the only caller is cloud.mjs:22 ('/settings/codex-cloud')
    },
    prefers: ['state:project-order', 'state:selected-project', 'state:thread-project-assignments', 'state:projectless-thread-ids',
      'state:thread-workspace-root-hints', 'service:repositoryOrigins', 'state:git-worktree-root', 'state:local-env-selections-by-workspace'],
    unchecked: [
      'stored electron-persisted-atom-state (the persisted atoms\' container)',
      'electron revealPath (LocalProject.reveal, Folder.reveal, File.reveal)',
      'electron postToWindow (navigate-to-route on the app\'s channel to its pages)',
      'action windows.tabs.open (File.open, Instructions.open, the tab of a ProjectAction\'s terminal)',
      'git worker requests through openIn.requestGitWorker: stable-metadata, current-branch, branch-metadata, default-branch, config-value, status-summary, upstream-branch, branch-ahead-count, recent-branches, review-summary, review-patch (Repository.workingChanges)',
      'open-in worker request get-target-command (openIn.requestOpenInWorker)',
      'page /settings/codex-cloud (the census lists settings.slugs, not this route); /settings/personalization and /settings/worktrees are allowed (:72) but no caller uses them',
    ],
  },

  'main:app-state': {
    // app-state.cjs reaches its services as `s.<name>` (:73-79), which the scan's patterns miss; ATOMS_KEY and PROJECTS_KEY are constants (:96).
    // `electron-persisted-atom-state` is the container of the atoms and is not in the census (it is listed in `unchecked`).
    needs: ['service:settings', 'service:appInfo', 'service:projects', 'service:accountInfo', 'service:accessInputs', 'state:local-projects',
      'state:electron:onboarding-projectless-completed'],
    assign: {
      'service:settings': ['graph:App', 'graph:Theme', 'graph:Setting', 'graph:SettingsSection'],   // :74-76 servicesOf returns null (nothing is reported) without it; Setting.set/reset and Theme.set follow through their types
      'service:appInfo': ['graph:App'],                  // :79 `s.appInfo && ... : null`: App.version says 'unknown' without it
      'service:projects': ['graph:App'],                 // :77 the global store, for `onboarded` only; :79 `store ... : null`
      'state:local-projects': ['graph:App'],             // :36,:96,:137 PROJECTS_KEY: `onboarded` is true when the app has a project
      'state:electron:onboarding-projectless-completed': ['graph:App'],   // :32,:138 ONBOARDED_ATOM, the other half of the app's own rule
      // `s.accountInfo || s.accessInputs` (:78): 21477 has both, 20770 only accessInputs. The account facts only name the ChatGPT account
      // (id, workspace); without them accounts.mjs puts it as `chatgpt` (accounts.mjs:21,:38). So they are preferred, not needed; anyOf
      // would apply to all ten features of this unit (generator: `for (const f of serves)`), not to the account.
      'service:accountInfo': ['graph:ChatGPTAccount'],
      'service:accessInputs': ['graph:ChatGPTAccount'],
      'message:navigate-to-route': ['graph:Account.manage'],   // :226-232 `navigate`, the only caller is accounts.mjs:221 ('/settings/account') (outside serves)
      // writeAtom: the window's kept sizes (layouts D4) are written by the app's own persisted-atom write where a window has it, else
      // through the store and every window told; Setting.reset takes the key away through the store
      'service:browserHost': ['graph:Setting.set'],
    },
    prefers: ['service:appInfo', 'service:projects', 'state:local-projects', 'state:electron:onboarding-projectless-completed', 'service:accountInfo', 'service:accessInputs',
      'service:browserHost'],
    unchecked: [
      'electron systemAppearance and onSystemAppearance (nativeTheme: Theme.appearance)',
      'electron clickAppMenuItem on the Help menu (App.openHelp)',
      'electron quitApp and onBeforeQuit (App.quit, App.quitting)',
      'electron openExternal (the ChatGPT sign-in page: Account.signIn)',
      'electron postToWindow (navigate-to-route)',
      'stored electron-persisted-atom-state (the persisted atoms\' container)',
      'page /settings/account (the census lists settings.slugs, not this route); /settings/usage is allowed (:35) but no caller uses it',
    ],
  },

  // ================================================================================================================ the feature areas
  // ---- agent-config
  'area:agent-config': {
    assign: {
      'protocol:config/read': ['graph:Setting'],                                    // agent-config.mjs:86,:95 the user and project layers
      'protocol:config/value/write': ['graph:Setting.set', 'graph:Setting.reset'],  // :162 a config setting's write (reset writes null); outside serves; Setting.set is also the app registry's (core:app-state)
      'protocol:config/batchWrite': ['graph:Model.makeDefault'],                    // :206
    },
  },
  'main:agent-config': {
    assign: {
      'service:workspaceFiles': ['graph:Setting.set', 'graph:Setting.reset'],       // agent-config.cjs:59 project-config-write (a project's .codex/config.toml), outside serves
      'service:projects': ['graph:Setting.set', 'graph:Setting.reset'],             // :56 kit.globalState: the roots must be a project's
      'state:local-projects': ['graph:Setting.set', 'graph:Setting.reset'],         // :56
      'service:queryCache': ['graph:Setting.set', 'graph:Setting.reset', 'graph:Model.makeDefault'],   // :53 kit.invalidate; host: the refresh failure is logged (agent-config.mjs:148-149)
    },
    prefers: ['service:queryCache'],
  },

  // ---- automations
  'area:automations': {
    // responded() (automations.mjs:184-196) only observes the app's thread answers to link heartbeat turns; notified() (:198-212) links turns and says `failed`;
    // thread/started also wakes Automation.runNow's wait (:200-203, a 15 s timeout answers null) and a read (the list is read every 60 s)
    assign: {
      'protocol:thread/start': ['graph:Automation'], 'protocol:thread/resume': ['graph:Automation'], 'protocol:thread/fork': ['graph:Automation'],
      'protocol:thread/read': ['graph:Automation'], 'protocol:thread/list': ['graph:Automation'], 'protocol:thread/turns/list': ['graph:Automation'],
      'protocol:thread/started': ['graph:Automation', 'graph:Automation.runNow'],
      'protocol:turn/started': ['graph:Automation'], 'protocol:turn/completed': ['graph:Automation'],
    },
    prefers: ['protocol:thread/start', 'protocol:thread/resume', 'protocol:thread/fork', 'protocol:thread/read', 'protocol:thread/list',
      'protocol:thread/turns/list', 'protocol:thread/started', 'protocol:turn/started', 'protocol:turn/completed'],
  },
  'main:automations': {
    // automations.cjs:32 notify() (called at :55 and :98) after run-now, update and delete refreshes the app's Automations page; the change is already made
    assign: {
      'message:automation-runs-updated': ['graph:Automation.runNow', 'graph:Automation.enable', 'graph:Automation.disable', 'graph:Automation.edit', 'graph:Automation.delete',
        'graph:Agent.newAutomation', 'graph:Project.newAutomation', 'graph:Thread.automate'],
      'message:navigate-to-route': ['graph:Automation.open'],   // automations.cjs:73
      'route:/scheduled': ['graph:Automation.open'],
    },
    prefers: ['message:automation-runs-updated'],
    dynamic: [{
      site: 'automations.cjs:73',
      reason: 'Automation.open: /automations?automationId=<id> (the path the app itself navigates to for its own new automation, '
        + '/automations?automationMode=create, which this build\'s unified layout shows as its Scheduled page, /scheduled), or for a heartbeat '
        + 'the chat it watches, /local/<thread id> (the census sees the local thread route only relative to its parent)',
      mechanics: ['message:navigate-to-route', 'route:/scheduled'],
    }],
  },

  // ---- browser
  'main:browser': {
    needs: ['service:projects'],   // browser.cjs:63 kit.threadIdOf -> kit.globalState (a chat begun in this profile names its tab by a client id)
    assign: {
      'service:browserHost': ['graph:BrowserTab'],           // browser.cjs:50 browserHostManager (tabs), :92 runPageCommand (navigate, reload, back, forward)
      'service:browserTabs': ['graph:BrowserTab'],           // :18-29 subscribeInvalidations: a push; the host reads every 15 s (browser.mjs:109)
      'message:close-browser-tab': ['graph:BrowserTab.close'],   // :77
      'service:projects': ['graph:BrowserTab'],              // via kit.threadIdOf (:63): the tab's `thread` link
    },
    prefers: ['service:browserTabs', 'service:projects'],
    unchecked: ['stored electron-persisted-atom-state: thread-client-id-v1:<thread> (kit.threadIdOf)'],
  },

  // ---- changes
  'area:changes': {
    assign: {
      'protocol:item/started': ['graph:ChangeSet', 'graph:FileChange', 'graph:Hunk'],               // changes.mjs:252 learn(fileChange items)
      'protocol:item/completed': ['graph:ChangeSet', 'graph:FileChange', 'graph:Hunk'],             // :252
      'protocol:item/fileChange/patchUpdated': ['graph:ChangeSet', 'graph:FileChange', 'graph:Hunk'],   // :253
      'protocol:thread/deleted': ['graph:ChangeSet', 'graph:FileChange', 'graph:Hunk'],             // :251 cleanup
      'protocol:thread/list': ['graph:ChangeSet', 'graph:FileChange', 'graph:Hunk'],                // :258-266 responded: observed answers (the core's loadThread does the reading)
      'protocol:thread/read': ['graph:ChangeSet', 'graph:FileChange', 'graph:Hunk'],
      'protocol:thread/resume': ['graph:ChangeSet', 'graph:FileChange', 'graph:Hunk'],
      'protocol:thread/turns/list': ['graph:ChangeSet', 'graph:FileChange', 'graph:Hunk'],
    },
    prefers: ['protocol:thread/deleted', 'protocol:thread/list', 'protocol:thread/read', 'protocol:thread/resume', 'protocol:thread/turns/list'],
  },
  'main:changes': {
    assign: {
      // changes.cjs:14-21 apply-patch (revert/apply of a change set, a file, a hunk); :39-41 open-in
      'service:openIn': ['graph:ChangeSet.revert', 'graph:ChangeSet.apply', 'graph:FileChange.revert', 'graph:FileChange.apply', 'graph:Hunk.revert', 'graph:Hunk.apply', 'graph:FileChange.openIn'],
      // :28-30 view-diff, open-file: windows.show_thread and windows.tabs.open
      'service:appActions': ['graph:FileChange.viewDiff', 'graph:FileChange.openFile', 'graph:FileEdit.openDiff', 'graph:FileEdit.openFile'],
    },
    unchecked: ['git worker request apply-patch (openIn.requestGitWorker)'],
  },

  // ---- commands
  'main:commands': {
    assign: {
      'service:commandKeybindings': ['graph:Command', 'graph:Shortcut'],        // commands.cjs:60,:66 get, update: the keymap is read with the catalog (commands.mjs:102-106)
      'service:applicationMenu': ['graph:Command.run'],                           // :77 the commands that only the app's menu runs (kind electron-only)
      'message:run-command': ['graph:Command.run'],                               // :91 every other command (see dynamic)
      'service:queryCache': ['graph:Shortcut.rebind', 'graph:Shortcut.reset'],    // :72 `try { await kit.invalidate(...) } catch {}`
    },
    prefers: ['service:queryCache'],
    dynamic: [{
      site: 'commands.cjs:100',   // `kit.runCommand(hooks, winId, args.commandId)`
      reason: 'Command.run runs the app command the Command instance names (its id, args.commandId, any command of the app\'s table); it is sent to the page as run-command, so the only fixed mechanic is that message',
      mechanics: ['message:run-command'],
    }],
    unchecked: ['the app\'s command table, found by shape among the app\'s loaded modules (commands.cjs:12-40)', 'application menu items by nativeCommandId (applicationMenu.getSnapshot, invokeItem)'],
  },

  // ---- comments
  'area:comments': {
    assign: {
      'protocol:turn/start': ['graph:Comment.send'],                   // comments.mjs:242 (a sent comment is a turn)
      'protocol:item/completed': ['graph:Comment'],                    // :162 a userMessage item: learn the sent comments (also learned when a realm observes, :195)
      'protocol:thread/read': ['graph:Comment'],                       // :163-166 responded
      'protocol:thread/resume': ['graph:Comment'],
      'protocol:thread/turns/list': ['graph:Comment'],
    },
    prefers: ['protocol:item/completed', 'protocol:thread/read', 'protocol:thread/resume', 'protocol:thread/turns/list'],
  },

  // ---- composer
  'area:composer': {
    assign: {
      'protocol:turn/started': ['graph:Draft.send'],                                   // composer.mjs:135,:186 submit waits for the turn the send starts
      'protocol:thread/started': ['graph:Project.newThread', 'graph:Agent.newThread'], // :135,:187-188 submit-new waits for the thread (when the chat starts with text); also everyChat (:181)
      'protocol:thread/list': ['graph:Draft'], 'protocol:thread/read': ['graph:Draft'], 'protocol:thread/start': ['graph:Draft'],   // :75,:176 THREAD_READS: observed answers put a draft for each chat
      'protocol:thread/resume': ['graph:Draft'], 'protocol:thread/fork': ['graph:Draft'],
    },
    prefers: ['protocol:thread/list', 'protocol:thread/read', 'protocol:thread/start', 'protocol:thread/resume', 'protocol:thread/fork'],
  },
  'main:composer': {
    assign: {
      'service:projects': ['graph:Draft'],                                               // composer.cjs:35 the persisted atoms of saved drafts, read from the global store
      'service:appActions': ['graph:Draft.setContent', 'graph:Draft.insert', 'graph:Draft.attach', 'graph:Draft.clear', 'graph:Draft.send', 'graph:Skill.use', 'graph:File.attachTo'],   // :53,:97 show(): windows.show_thread before every edit of a chat's composer
      'message:codex-micro-insert-composer-text': ['graph:Draft.setContent', 'graph:Draft.insert'],     // :100
      'message:codex-micro-insert-skill-mention': ['graph:Skill.use'],                    // :102 (setContent and insert only with skills in the content)
      'message:add-context-file': ['graph:Draft.attach', 'graph:File.attachTo'],          // :104
      'command:composer.clear': ['graph:Draft.setContent', 'graph:Draft.clear'],          // :98
      'command:composer.submit': ['graph:Draft.send', 'graph:Project.newThread', 'graph:Agent.newThread'],   // :105 and :92 (submit-new)
      'message:run-command': ['graph:Draft.setContent', 'graph:Draft.clear', 'graph:Draft.send', 'graph:Project.newThread', 'graph:Agent.newThread'],   // carries the two commands
      'message:navigate-to-route': ['graph:Project.newThread', 'graph:Agent.newThread'], // :87 new-chat navigates to '/'
      'route:/': ['graph:Project.newThread', 'graph:Agent.newThread'],
    },
    unchecked: ['stored electron-persisted-atom-state: composer-prompt-drafts-v2 (composer.cjs:11,:21; not in the census\' atom list)',
      'the commands run only where a mounted composer handles them (area-kit runCommand)'],
  },

  // ---- computer-use
  'area:computer-use': {
    assign: {
      'protocol:turn/completed': ['graph:ComputerUseSession'],        // computer-use.mjs:61 ends the session when its turn ends (event stopped)
      'protocol:thread/archived': ['graph:ComputerUseSession'],       // :62 cleanup
      'protocol:thread/closed': ['graph:ComputerUseSession'],
      'protocol:thread/deleted': ['graph:ComputerUseSession'],
      'protocol:turn/interrupt': ['graph:ComputerUseSession.stop'],   // :80
    },
    prefers: ['protocol:thread/archived', 'protocol:thread/closed', 'protocol:thread/deleted'],
  },

  // ---- history
  'main:history': {
    assign: {
      'service:repositoryOrigins': ['graph:Commit', 'graph:Repository.commit', 'graph:GitRepository.stage', 'graph:GitRepository.unstage', 'graph:ChangeSet.commit'],   // history.cjs:30-31 the root, else the git worker's stable-metadata (:36)
      'service:projects': ['graph:Repository.commit', 'graph:ChangeSet.commit'],                      // :87 kit.globalState, inside try/catch with the app's default
      'state:git-action-include-unstaged-changes': ['graph:Repository.commit', 'graph:ChangeSet.commit'],   // :87 `?? true`
    },
    prefers: ['service:repositoryOrigins', 'service:projects', 'state:git-action-include-unstaged-changes'],
    unchecked: ['git worker requests through openIn.requestGitWorker: stable-metadata, review-summary, apply-review-section-changes, branch-commits, cat-file, commit'],
  },

  // ---- notifications
  'main:notifications': {
    assign: { 'service:appActions': ['graph:Notification.open'] },   // notifications.cjs:75 windows.show_thread when the notification names a chat (hide is the notifications service, for both)
  },

  // ---- plugins
  'area:plugins': {
    assign: {
      'protocol:plugin/list': ['graph:Plugin'], 'protocol:plugin/installed': ['graph:Plugin'],         // plugins.mjs:62-63
      'protocol:config/read': ['graph:Plugin'], 'protocol:app/installed': ['graph:Plugin'],            // :64,:66 (no try: readOnce fails without them)
      'protocol:plugin/read': ['graph:Plugin'],                                                         // :83 try/catch: only `connected` stays unknown
      'protocol:plugin/install': ['graph:Plugin.install'],                                              // :152
      'protocol:plugin/uninstall': ['graph:Plugin.uninstall'],                                          // :153
      'protocol:config/batchWrite': ['graph:Plugin.enable', 'graph:Plugin.disable'],                    // :154
      'protocol:config/value/write': ['graph:Plugin'],                                                  // :186 responded: an observed write wakes a read
      'protocol:app/list/updated': ['graph:Plugin'], 'protocol:skills/changed': ['graph:Plugin'], 'protocol:account/updated': ['graph:Plugin'],   // :185 schedule a read
    },
    prefers: ['protocol:plugin/read', 'protocol:config/value/write', 'protocol:app/list/updated', 'protocol:skills/changed', 'protocol:account/updated'],
  },
  'main:plugins': {
    assign: {
      'service:queryCache': ['graph:Plugin.install', 'graph:Plugin.uninstall', 'graph:Plugin.enable', 'graph:Plugin.disable'],   // plugins.mjs:157-163 refresh: a failure is logged
      'service:browserPluginConfig': ['graph:Plugin.install', 'graph:Plugin.uninstall', 'graph:Plugin.enable', 'graph:Plugin.disable'],   // plugin-sync, same
      'message:navigate-to-route': ['graph:Plugin.connect', 'graph:Plugin.disconnect'],               // plugins.cjs:19
      'route:/plugins/:pluginId': ['graph:Plugin.connect', 'graph:Plugin.disconnect'],
    },
    prefers: ['service:queryCache', 'service:browserPluginConfig'],
    dynamic: [{
      site: 'plugins.cjs:19',
      reason: 'the page path comes from the Host: /plugins/<plugin id> for Plugin.connect and disconnect (plugins.mjs:171), checked against /^\\/plugins\\/[^/]+$/ (plugins.cjs:13)',
      mechanics: ['message:navigate-to-route', 'route:/plugins/:pluginId'],
    }],
  },

  // ---- pull-requests
  'area:pull-requests': {
    needs: ['service:gitRepository'],   // pull-requests.mjs:225 ctx.pushRepository: ChangeSet.openPullRequest pushes the branch the app's way first
    assign: {
      'protocol:thread/attachment/add': ['graph:ChangeSet.openPullRequest'],   // :233 (outside the create: no catch)
      'protocol:thread/attachment/updated': ['graph:GitHubPullRequest'],       // :202 the thread a pull request is attached to
      'service:gitRepository': ['graph:ChangeSet.openPullRequest'],
    },
    prefers: ['protocol:thread/attachment/updated'],
  },
  'main:pull-requests': {
    // repositoryRoot (pull-requests.cjs:36-51): repositoryOrigins, else the git worker's stable-metadata
    anyOf: [['service:repositoryOrigins', 'service:openIn']],
    assign: {
      'service:projects': ['graph:PullRequest.merge'],                    // :109 kit.globalState, not in a try
      'state:git-pull-request-merge-method': ['graph:PullRequest.merge'], // :109 `?? 'merge'`; the key must exist for the app to have the setting
    },
    unchecked: ['github service requests: gh-cli-status, gh-current-user, gh-pr-board, gh-pr-create, gh-pr-summary, gh-pr-reviews, gh-pr-update, gh-pr-merge',
      'git worker request stable-metadata (openIn.requestGitWorker)'],
  },

  // ---- queue
  'area:queue': {
    assign: {
      'protocol:thread/queue/list': ['graph:QueuedMessage', 'graph:Thread.enqueue'],   // queue.mjs:53; enqueue reads the queue to return the new message (:133)
      'protocol:thread/queue/changed': ['graph:QueuedMessage'],                        // :107 the live feed
      'protocol:thread/queue/add': ['graph:Thread.enqueue'],                           // :132
      'protocol:thread/queue/update': ['graph:QueuedMessage.edit'],                    // :142
      'protocol:thread/queue/delete': ['graph:QueuedMessage.remove', 'graph:QueuedMessage.sendNow'],   // :150,:175
      'protocol:thread/queue/reorder': ['graph:QueuedMessage.move'],                   // :164
      'protocol:thread/queue/start': ['graph:QueuedMessage.sendNow'],                  // :178 (a running turn is steered instead)
      'protocol:turn/steer': ['graph:QueuedMessage.sendNow'],                          // :174
      'protocol:item/started': ['graph:QueuedMessage'],                                // the user message's client id: the source's signal of `sent`
    },
    prefers: ['protocol:item/started'],
  },

  // ---- review
  'area:review': {
    assign: {
      'protocol:item/started': ['graph:Review', 'graph:Finding'],       // review.mjs:209-216 notified: learn the review from the turn's messages
      'protocol:item/completed': ['graph:Review', 'graph:Finding'],
      'protocol:turn/started': ['graph:Review', 'graph:Finding'],
      'protocol:turn/completed': ['graph:Review', 'graph:Finding'],
      'protocol:thread/read': ['graph:Review', 'graph:Finding'],        // :216 responded: observed answers
      'protocol:thread/resume': ['graph:Review', 'graph:Finding'],
      'protocol:thread/turns/list': ['graph:Review', 'graph:Finding'],
      'protocol:turn/interrupt': ['graph:Review.stop'],                 // :239
    },
    prefers: ['protocol:thread/read', 'protocol:thread/resume', 'protocol:thread/turns/list'],
  },
  'main:review': {
    assign: {
      'service:appActions': ['graph:Finding.open'],                    // review.cjs:20-21 windows.show_thread, windows.tabs.open
      'service:projects': ['graph:Finding.dismiss'],                   // :30 kit.globalState: the dismissed keys are persisted atoms; also read for the `dismissed` state of every finding (a failure is logged, review.mjs:135)
      'message:persisted-atom-updated': ['graph:Finding.dismiss'],     // :43 tells the app's pages the atom changed; the key is saved already
    },
    prefers: ['message:persisted-atom-updated'],
    unchecked: ['stored electron-persisted-atom-state: dismissed-model-diff-comments-v3:<client id>:<key>, thread-client-id-v1:<thread>'],
  },

  // ---- run-control
  'area:run-control': {
    assign: {
      'protocol:thread/backgroundTerminals/list': ['graph:CommandRun.stop'],        // run-control.mjs:146
      'protocol:thread/backgroundTerminals/terminate': ['graph:CommandRun.stop'],   // :151
      'protocol:turn/started': ['graph:Turn.retry', 'graph:Turn.rewind'],           // :155 only returns the new turn (a 20 s timeout answers null, :132)
    },
    prefers: ['protocol:turn/started'],
  },
  'main:run-control': {
    // retry and rewind go through the app's thread-follower request (run-control.cjs:21), which area-kit.cjs:128,:148 sends with the AppView's
    // clientCoordination service (21477 has it, 20770 does not), after windows.show_thread when no window holds the chat (area-kit.cjs:140)
    needs: ['service:clientCoordination', 'service:appActions'],
    assign: {
      'service:clipboard': ['graph:Turn.copy', 'graph:Message.copy', 'graph:Step.copy', 'graph:CommandRun.copyCommand', 'graph:CommandRun.copyOutput'],   // :10
      'service:clientCoordination': ['graph:Turn.retry', 'graph:Turn.rewind'],
      'service:appActions': ['graph:Turn.retry', 'graph:Turn.rewind'],
    },
    prefers: ['service:appActions'],
    unchecked: ['action windows.show_thread (area-kit followerRequest, when no window holds the chat)'],
  },

  // ---- skills
  'area:skills': {
    assign: {
      'protocol:skills/list': ['graph:Skill'],                                         // skills.mjs:90
      'protocol:skills/config/write': ['graph:Skill.enable', 'graph:Skill.disable'],   // :167
      'protocol:skills/changed': ['graph:Skill'],                                      // :177 schedules a read
      'protocol:plugin/install': ['graph:Skill'], 'protocol:plugin/uninstall': ['graph:Skill'],   // :178 responded: observed answers
    },
    prefers: ['protocol:skills/changed', 'protocol:plugin/install', 'protocol:plugin/uninstall'],
  },
  'main:skills': {
    assign: {
      'service:recommendedSkills': ['graph:Skill.install', 'graph:Skill.delete'],   // skills.cjs:15,:22 install, remove (the library list, :10, is optional: skills.mjs:70-73)
      'service:appActions': ['graph:Skill.edit'],                                    // :29
      'service:queryCache': ['graph:Skill.enable', 'graph:Skill.disable', 'graph:Skill.delete', 'graph:Skill.install'],   // :36 refresh; failure logged (skills.mjs:136-137)
    },
    prefers: ['service:queryCache'],
  },

  // ---- terminals
  'area:terminals': {
    assign: {
      'protocol:thread/backgroundTerminals/terminate': ['graph:Terminal.stop', 'graph:Terminal.close'],   // terminals.mjs:237 the agent's terminals (the user's go through the app's terminal service)
      // the agent's terminals are learned from the commandExecution items (:198-218) and the answers: a subset of the Terminal instances
      'protocol:item/started': ['graph:Terminal'], 'protocol:item/completed': ['graph:Terminal'],
      'protocol:turn/started': ['graph:Terminal'], 'protocol:turn/completed': ['graph:Terminal'],
      'protocol:thread/closed': ['graph:Terminal'], 'protocol:thread/deleted': ['graph:Terminal'],
      'protocol:thread/read': ['graph:Terminal'], 'protocol:thread/resume': ['graph:Terminal'], 'protocol:thread/turns/list': ['graph:Terminal'],
    },
    prefers: ['protocol:item/started', 'protocol:item/completed', 'protocol:turn/started', 'protocol:turn/completed', 'protocol:thread/closed',
      'protocol:thread/deleted', 'protocol:thread/read', 'protocol:thread/resume', 'protocol:thread/turns/list'],
  },
  'main:terminals': {
    needs: ['service:projects'],   // terminals.cjs:65 kit.threadIdOf -> kit.globalState (the terminal's thread by client id)
    assign: {
      'service:appActions': ['graph:Terminal.focus'],     // :71-72 windows.show_thread, windows.tabs.open
      'service:projects': ['graph:Terminal'],
    },
    prefers: ['service:projects'],
    unchecked: ['stored electron-persisted-atom-state: thread-client-id-v1:<thread> (kit.threadIdOf)'],
  },

  // ---- thread-settings
  'area:thread-settings': {
    // the settings are put from the app's own answers (thread/start, resume, fork) and from thread/settings/updated; an update's own answer is applied (thread-settings.mjs:82)
    assign: {
      'protocol:thread/settings/update': ['graph:Model._select', 'graph:Setting.set'],   // :81 (Setting.set outside serves; reset is refused, :118)
      'protocol:thread/settings/updated': ['graph:Setting', 'graph:SettingsSection'],   // :89
      'protocol:thread/start': ['graph:Setting', 'graph:SettingsSection'], 'protocol:thread/resume': ['graph:Setting', 'graph:SettingsSection'],
      'protocol:thread/fork': ['graph:Setting', 'graph:SettingsSection'],               // :90-98 responded
    },
    prefers: ['protocol:thread/settings/updated', 'protocol:thread/start', 'protocol:thread/resume', 'protocol:thread/fork'],
  },

  // ---- threads
  'area:threads': {
    assign: {
      'protocol:turn/start': ['graph:Thread.send'],                    // threads.mjs:112
      'protocol:turn/steer': ['graph:Thread.steer'],                   // :121
      'protocol:turn/interrupt': ['graph:Thread.stop'],                // :129
      'protocol:thread/goal/set': ['graph:Thread.stop'],               // :128 only when a goal is active (no goal without the method)
      'protocol:thread/backgroundTerminals/clean': ['graph:Thread.stop'],   // :130 bestEffort
      'protocol:thread/archive': ['graph:Thread.archive'],             // :137
      'protocol:thread/unarchive': ['graph:Thread.restore'],           // :150
      'protocol:thread/fork': ['graph:Thread.fork'],                   // :166
      'protocol:thread/compact/start': ['graph:Thread.compact'],       // :183
      'protocol:thread/settings/update': ['graph:Thread.setModel'],    // :189
      'protocol:thread/section/move': ['graph:Thread.pin', 'graph:Thread.unpin'],   // :87 an observed answer wakes a pins read
      // observed traffic that re-applies the pins to a thread the core just put (:84,:93)
      'protocol:thread/started': ['graph:Thread.pin', 'graph:Thread.unpin'],
      'protocol:thread/start': ['graph:Thread.pin', 'graph:Thread.unpin'], 'protocol:thread/resume': ['graph:Thread.pin', 'graph:Thread.unpin'],
      'protocol:thread/read': ['graph:Thread.pin', 'graph:Thread.unpin'], 'protocol:thread/list': ['graph:Thread.pin', 'graph:Thread.unpin'],
    },
    prefers: ['protocol:thread/goal/set', 'protocol:thread/backgroundTerminals/clean', 'protocol:thread/section/move', 'protocol:thread/started',
      'protocol:thread/start', 'protocol:thread/resume', 'protocol:thread/read', 'protocol:thread/list'],
  },
  'main:threads': {
    assign: {
      'service:appActions': ['graph:Thread.open'],                                 // threads.cjs:39 windows.show_thread
      'service:pinnedThreads': ['graph:Thread.pin', 'graph:Thread.unpin'],         // :8,:16 list, set (the host also reads the pins for the `pinned` member)
      'service:managedWorktrees': ['graph:Thread.archive', 'graph:Thread.restore'],   // :21,:30 registerThreadArchive/Unarchive: bestEffort (threads.mjs:136,:149)
      'service:threadArchive': ['graph:Thread.delete'],                            // :35 deleteArchivedThread (archiveInactiveThread, :26, is Thread.archive's fallback)
    },
    prefers: ['service:managedWorktrees'],
  },

  // ---- tool-servers
  'area:tool-servers': {
    assign: {
      'protocol:config/read': ['graph:ToolServer', 'graph:Tool'],                    // tool-servers.mjs:92 (readOnce has no catch inside)
      'protocol:mcpServerStatus/list': ['graph:ToolServer', 'graph:Tool'],           // :102
      'protocol:config/batchWrite': ['graph:ToolServer.edit', 'graph:ToolServer.remove', 'graph:CodexAgent.addToolServer'],   // change(): the edit and remove writes (see dynamic); addition()
      'protocol:config/value/write': ['graph:ToolServer.enable', 'graph:ToolServer.disable', 'graph:Tool.enable', 'graph:Tool.disable'],   // change(): enabled and the tool lists
      'protocol:config/mcpServer/reload': ['graph:ToolServer.restart'],              // :243 (the sign-in's reload, :203, is in a try/catch)
      'protocol:mcpServer/oauth/login': ['graph:ToolServer.signIn'],                 // :231
      'protocol:mcpServer/oauthLogin/completed': ['graph:ToolServer.signIn'],        // :214 reloads the servers when the login ends
      'protocol:mcpServer/startupStatus/updated': ['graph:ToolServer', 'graph:Tool'],   // :215 schedules a read (the status is read every observation)
      'protocol:account/updated': ['graph:ToolServer', 'graph:Tool'], 'protocol:app/list/updated': ['graph:ToolServer', 'graph:Tool'],
    },
    prefers: ['protocol:mcpServer/oauthLogin/completed', 'protocol:mcpServer/startupStatus/updated', 'protocol:account/updated', 'protocol:app/list/updated'],
    dynamic: [{
      site: 'tool-servers.mjs:420',
      reason: 'the method is chosen by change(): config/value/write (enable and disable of a server or a tool) or config/batchWrite (edit and remove of a server)',
      mechanics: ['protocol:config/value/write', 'protocol:config/batchWrite'],
    }],
  },
  'main:tool-servers': {
    // tool-servers.cjs:10 refresh after a write (logged on failure, tool-servers.mjs:190-194); open-url is the electron call listed by the scan
    assign: { 'service:queryCache': ['graph:ToolServer.edit', 'graph:ToolServer.remove', 'graph:ToolServer.enable', 'graph:ToolServer.disable', 'graph:Tool.enable', 'graph:Tool.disable'] },
    prefers: ['service:queryCache'],
  },
};
