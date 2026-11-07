'use strict';
// Read saved drafts without writing the atom store; edit and send through the app's mounted composer. A new chat's draft (mod-surfaces.md
// §3.6) is the app's own key, `new-conversation` (the main window's home and the hotkey window's share it, whatever the project) and
// `panel-new-conversation` (the "new thread" page of the panel and hotkey window); its target's project is the app's selected project.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const kit = require('../area-kit.cjs');

const ATOMS = 'electron-persisted-atom-state';
const mention = (skill) => ({ name: skill.name, displayName: skill.name, path: skill.path, description: '', iconSmall: null });
const DRAFTS = 'composer-prompt-drafts-v2';
const NEW_KEYS = ['new-conversation', 'panel-new-conversation'];
const NEW_PREFIX = 'new:app:';
// A new chat's access as the app keeps it (docs/research/new-chat-state-21477.md, checked natively): the local host's selection, which every
// composer of that host shows; the permissions menu writes both atoms. Full access is the user's (the app asks first): never written here.
const ACCESS_MODES = { ask: 'auto', approve: 'guardian-approvals' };
const selectedOf = (store) => { const s = store?.get?.('selected-project'); return s && s.type === 'local' && typeof s.projectId === 'string' && s.projectId.length <= 200 ? s.projectId : null; };

function register(hooks) {
  let bound = null, timer = null;
  function report() {
    timer = null;
    const drafts = [];
    const atoms = bound?.store.get(ATOMS);
    const entries = atoms?.[DRAFTS];
    for (const [key, entry] of Object.entries(entries ?? {})) {
      const id = key.startsWith('local:') ? key.slice(6) : NEW_KEYS.includes(key) ? `${NEW_PREFIX}${key}` : null;
      if (!id) continue;
      const doc = entry?.prompt?.document;
      const json = JSON.stringify(doc);
      if (json !== undefined && Buffer.byteLength(json) <= 64 * 1024) drafts.push({ threadId: id, doc });
    }
    // the new chat's target: the project it starts in (null: none); its own client id (the id the app binds to the thread its send
    // makes: graph-layers.md §3.2, docs/research/new-chat-state-21477.md)
    const ids = atoms?.['draft-thread-identities-v1'];
    const clientId = typeof ids?.['new-conversation'] === 'string' && ids['new-conversation'].length <= 200 ? ids['new-conversation'] : null;
    // the cloud environment a cloud chat starts in: the app's one choice for every new chat (null: none stored, the composer takes the
    // account's first)
    const env = atoms?.environment;
    const cloud = env && typeof env === 'object' ? { id: String(env.id ?? '').slice(0, 200), label: String(env.label ?? '').slice(0, 200) } : null;
    hooks.areaReport('composer', { drafts, newChat: { project: selectedOf(bound?.store), clientId, cloud } });
  }
  function schedule() {
    if (timer) return;
    timer = setTimeout(report, 300);
    timer.unref?.();
  }
  function bind() {
    if (bound) return;
    for (const w of hooks.appHost?.windows?.() ?? []) {
      const store = w.host?.services?.projects?.globalState;
      if (!store || typeof store.get !== 'function') continue;
      const offs = typeof store.onDidChange === 'function' ? [store.onDidChange(ATOMS, schedule), store.onDidChange('selected-project', schedule)] : [];
      bound = { winId: w.id, store, off: () => { for (const f of offs) { try { if (typeof f === 'function') f(); else f?.dispose?.(); } catch { /* the store went */ } } } };
      schedule();
      return;
    }
  }
  hooks.appHost?.subscribe?.((e) => {
    if (e.type === 'removed' && bound?.winId === e.id) {
      if (typeof bound.off === 'function') bound.off();
      bound = null;
      bind();
      schedule();
    } else if (e.type === 'added' && !bound) bind();
  });
  hooks.onHostMessage('ready', schedule);
  bind();

  /** The window an operation names (its page's id): that window when it is open, else refused; none named: the app's first window. */
  function windowOf(windowId) {
    if (windowId === undefined) return kit.windowServices(hooks).winId;
    if (!Number.isSafeInteger(windowId) || !(hooks.appHost?.windows?.() ?? []).some((w) => w.id === windowId)) throw kit.refusal('that window is not open');
    return windowId;
  }
  async function show(threadId, windowId) {
    if (typeof threadId !== 'string' || !threadId.trim() || threadId.length > 200) throw kit.refusal('a threadId of at most 200 characters is needed');
    // a new chat's draft: the main window's new chat (its composer is the one the host messages reach); the panel page's is not reachable
    if (threadId === `${NEW_PREFIX}new-conversation`) {
      const winId = windowOf(windowId);
      kit.navigate(hooks, winId, '/', {});
      await new Promise((resolve) => setTimeout(resolve, 600));
      return winId;
    }
    if (threadId.startsWith(NEW_PREFIX)) throw kit.refusal('this new chat\'s composer is not reachable from here');
    // one window for the whole operation: the chat is shown in it and every message after goes to it (not to whichever window is first
    // by then); a window that closed in between is a refusal, never another window's composer
    const winId = windowOf(windowId);
    const windows = () => (hooks.appHost && typeof hooks.appHost.windows === 'function' ? hooks.appHost.windows() : []);
    const action = { type: 'windows.show_thread', windowId: 'current', threadId };
    // in that window when its page's actions are reachable (21477), else the app's primary window's (which is the first)
    if (typeof windows().find((w) => w.id === winId)?.view?.services?.appActions?.run === 'function') await kit.appActionIn(hooks, winId, action);
    else await kit.appAction(hooks, action);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const still = windows().some((w) => w.id === winId);
    if (!still) throw kit.refusal('the window closed before the composer could be reached');
    return winId;
  }
  /**
   * Write persisted atoms as the app does, so every window's composer sees them at once: the app's own write and broadcast
   * (`browserHost.messageHandler.updatePersistedAtomState`) where it is reachable, else the store and the same broadcast to each window.
   */
  async function writeAtoms(entries) {
    const w = hooks.appHost?.first?.();
    const handler = w?.host?.services?.browserHost?.messageHandler;
    if (handler && typeof handler.updatePersistedAtomState === 'function') {
      for (const [key, value] of entries) handler.updatePersistedAtomState(null, key, value);
      return 'app';
    }
    const store = bound?.store;
    if (!store || typeof store.set !== 'function') throw kit.refusal("the app's state cannot be written from here");
    const atoms = { ...(store.get(ATOMS) ?? {}) };
    for (const [key, value] of entries) atoms[key] = value;
    await kit.withTimeout(store.set(ATOMS, atoms));
    for (const win of hooks.appHost.windows()) for (const [key, value] of entries) kit.postToView(hooks, win.id, { type: 'persisted-atom-updated', key, value, deleted: false });
    return 'store';
  }
  hooks.onAreaOp('composer', async (op, args = {}) => {
    // the new chat's access (ask, approve): the local host's selection, as the permissions menu writes it, without the menu
    if (op === 'set-access') {
      const mode = ACCESS_MODES[args?.access];
      if (!mode) throw kit.refusal('access is ask or approve here');
      const byHost = bound?.store?.get(ATOMS)?.['agent-mode-by-host-id'];
      const by = await writeAtoms([['permission-selection-by-host-id:local', { kind: 'agent-mode', agentMode: mode }],
        ['agent-mode-by-host-id', { ...(byHost && typeof byHost === 'object' ? byHost : {}), local: mode }]]);
      return { by };
    }
    if (op === 'prompts') {
      const home = process.env.CODEX_HOME;
      const dir = path.join(path.resolve(typeof home === 'string' && home.length > 0 && home.length <= 4096 ? home : path.join(os.homedir(), '.codex')), 'prompts');
      let files;
      try { files = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return { prompts: [] }; throw e; }
      const prompts = [];
      for (const name of files.filter((f) => f.isFile() && f.name.endsWith('.md')).map((f) => f.name).sort()) {
        let content = await fs.readFile(path.join(dir, name), 'utf8');
        let description = '', argumentHint = '';
        const front = content.match(/^---\r?\n((?:[^\n]*\n)*?)---(?:\r?\n|$)/);
        if (front) {
          for (const line of front[1].split(/\r?\n/)) {
            const m = line.match(/^(description|argument-hint):\s*(.*?)\s*$/);
            if (!m) continue;
            const value = m[2].replace(/^(["'])([\s\S]*)\1$/, '$2');
            if (m[1] === 'description') description = value;
            else argumentHint = value;
          }
          content = content.slice(front[0].length);
        }
        content = new StringDecoder('utf8').write(Buffer.from(content).subarray(0, 16 * 1024));
        prompts.push({ id: name.slice(0, -3), description, argumentHint, content });
      }
      return { prompts };
    }
    if (op === 'new-chat') {
      // the window the operation chose (its page's id), when it says one: it is that window or none (graph-layers.md §2)
      const winId = windowOf(args?.windowId);
      // the project the new chat starts in: the home page applies the route state's `project` (null: no project) as the app's own new chat does
      if (args?.projectId !== undefined && args.projectId !== null && (typeof args.projectId !== 'string' || !args.projectId || args.projectId.length > 200)) throw kit.refusal('a project id of at most 200 characters, or null for no project');
      const project = args?.projectId === undefined ? {} : { project: args.projectId === null ? null : { type: 'local', projectId: args.projectId } };
      // where it runs (E8.3b): the app's own route seeds for its run location (as its project menu's "new chat" does)
      if (args?.mode !== undefined && !['local', 'worktree', 'cloud'].includes(args.mode)) throw kit.refusal('a mode is local, worktree or cloud');
      const mode = args?.mode === undefined ? {} : { prefillComposerMode: args.mode, ...(args.mode === 'local' ? { prefillLocalExecution: true } : {}) };
      kit.navigate(hooks, winId, '/', { focusComposerNonce: Date.now(), ...project, ...mode, ...(args?.text ? { prefillPrompt: args.text } : {}) });
      return { windowId: winId };   // the window the new chat shows in: the rest of an operation stays there
    }
    // the thread a client id was bound to (the app's own record of a new chat's send), or null while it is not
    if (op === 'bound') {
      if (typeof args?.clientId !== 'string' || !args.clientId || args.clientId.length > 200) throw kit.refusal('a client id is needed');
      const bindings = bound?.store.get(ATOMS)?.['client-thread-bindings-v1'];
      const threadId = bindings && typeof bindings === 'object' ? bindings[args.clientId] : null;
      return { threadId: typeof threadId === 'string' && threadId.length <= 200 ? threadId : null };
    }
    if (op === 'submit-new') {
      const winId = windowOf(args?.windowId);
      await new Promise((resolve) => setTimeout(resolve, 800));
      kit.runCommand(hooks, winId, 'composer.submit');
      return {};
    }
    // a chat shown in a window, so the Host can then act on its composer there (H5x review 1): the window it is in
    if (op === 'show') return { windowId: await show(args?.threadId, args?.windowId) };
    if (!['set-text', 'insert', 'attach', 'clear', 'submit'].includes(op)) throw kit.refusal(`unknown operation ${op}`);
    if (op === 'attach' && (typeof args?.path !== 'string' || !path.isAbsolute(args.path))) throw kit.refusal('an absolute path is needed');
    // to a composer the Host knows is shown in that window (and focused there for the messages): at once, with no navigation (no wait the
    // user could type in: graph-layers.md §3.2)
    const winId = args?.shown === true && args?.windowId !== undefined ? windowOf(args.windowId) : await show(args?.threadId, args?.windowId);
    if (op === 'set-text' || op === 'clear') kit.runCommand(hooks, winId, 'composer.clear');
    if (op === 'set-text' || op === 'insert') {
      if (typeof args.text === 'string' && args.text) kit.postToView(hooks, winId, { type: 'codex-micro-insert-composer-text', text: args.text });
      // The composer's mention node needs each of its attributes: natively a mention without description and iconSmall was not inserted.
      for (const skill of Array.isArray(args.skills) ? args.skills : []) kit.postToView(hooks, winId, { type: 'codex-micro-insert-skill-mention', skill: mention(skill) });
    }
    if (op === 'attach') kit.postToView(hooks, winId, { type: 'add-context-file', file: { label: path.basename(args.path), path: args.path, fsPath: args.path } });
    if (op === 'submit') kit.runCommand(hooks, winId, 'composer.submit');
    return {};
  });
}

module.exports = { register };
