// qa.graph-census — QA only (coverage evidence, docs/design/breadth.md §3). What the native provider put in the graph of a QA copy, by
// instance type: the number of instances and, per state field and link, how many carry it. scripts/coverage.mjs counts a member as
// verified when a census of the build shows it.
import fs from 'node:fs/promises';
import path from 'node:path';
// the SDK's helpers for the agent's inputs (graph-integrity G3.5), as its bundle has them (sdk-agent.mjs)
import { instructions, tool, skills } from './sdk-agent.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NATIVE = 'codex';
/** The framework's own provider (docs/graph/07, systems.md S3): its instances are counted too. */
const FRAMEWORK = 'codexmods.framework';
const COUNTED = new Set([NATIVE, FRAMEWORK]);
const RECENT = 8;          // threads observed so their turns, messages, steps and requests load
const LOAD_MS = 8000;
const present = (v) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0);

async function host(ctx) {
  const files = path.join(ctx.mod.dataDir, 'files');
  await fs.mkdir(files, { recursive: true });
  // what the agent gets from this mod (graph-integrity G3.5, the SDK's helpers on the agent's inputs): a tool, a skill folder, a chat's
  // instructions and a turn's context
  tool(ctx, { name: 'qa_echo', description: 'QA only: echoes the text it is given back, prefixed with QA-TOOL. Call it when the user asks for the QA echo.',
    input: { type: 'object', properties: { text: { type: 'string', description: 'The text to echo back' } }, required: ['text'], additionalProperties: false },
    run: async (args, env) => {
      await fs.appendFile(path.join(files, 'act.log'), `${new Date().toISOString()} qa_echo ${JSON.stringify({ args, thread: env.thread?.id, turn: env.turn?.id, call: env.call })}\n`);
      return `QA-TOOL ${String(args?.text ?? '')}`;
    } });
  skills(ctx, new URL('./skills', import.meta.url));
  instructions(ctx, 'QA census: when the user asks for the QA codeword, answer exactly PLUM-77.');
  instructions(ctx, () => 'QA census, this turn: the QA fruit is MANGO-31.');
  // G3.5's native check: what the agent's inputs carried as they went (the mods' blocks in their order, the tools' namespaces), to agent.log
  const marks = (s) => [...String(s ?? '').matchAll(/<mod_instructions mod="([^"]+)">/g)].map((m) => m[1]);
  for (const [type, op] of [['CodexAgent', '_startThread'], ['CodexThread', '_resume']]) {
    ctx.graph.after(type, op, async (rec) => {
      const p = Array.isArray(rec?.effectiveArgs) ? rec.effectiveArgs[0] : null;
      await fs.appendFile(path.join(files, 'agent.log'), `${JSON.stringify({ t: new Date().toISOString(), op, status: rec?.outcome?.status ?? null, error: rec?.outcome?.error?.message ?? rec?.outcome?.message ?? null, ref: rec?.ref?.id ?? null,
        blocks: marks(p?.developerInstructions), tools: (Array.isArray(p?.dynamicTools) ? p.dynamicTools : []).map((x) => x?.name), changedBy: rec?.changedBy ?? null, ephemeral: p?.ephemeral === true,
        mcp: p?.config && typeof p.config === 'object' ? JSON.stringify(p.config.mcp_servers ?? p.config['mcp_servers.node_repl'] ?? Object.keys(p.config)).slice(0, 600) : null })}\n`).catch(() => {});
    });
  }
  let running = false;
  async function census() {
    if (running) return;
    running = true;
    const subs = [];
    try {
      const threads = (await ctx.graph.list('Thread')).filter((t) => t.ref.provider === NATIVE)
        .sort((a, b) => (b.state.updatedAt ?? 0) - (a.state.updatedAt ?? 0)).slice(0, RECENT);
      for (const t of threads) subs.push(ctx.graph.subscribe({ ref: t.ref }, () => {}));
      await sleep(LOAD_MS);
      const concepts = (await ctx.graph.types()).filter((t) => (t.owner === 'native' || t.owner === 'framework') && t.kind === 'concept').map((t) => t.id);
      const types = {};
      for (const c of concepts) {
        for (const s of await ctx.graph.list(c)) {
          if (!COUNTED.has(s.ref.provider)) continue;
          const e = types[s.ref.type] ??= { count: 0, state: {}, links: {} };
          e.count++;
          for (const [k, v] of Object.entries(s.state ?? {})) if (present(v)) e.state[k] = (e.state[k] ?? 0) + 1;
          for (const [k, v] of Object.entries(s.links ?? {})) if (present(v)) e.links[k] = (e.links[k] ?? 0) + 1;
        }
      }
      // Which Codex threads each project links (D3: compared with the app's own sidebar query), active and archived apart.
      const projects = {};
      for (const th of (await ctx.graph.list('Thread')).filter((x) => x.ref.provider === NATIVE)) {
        const id = th.links?.project?.id ?? '(none)';
        const e = projects[id] ??= { active: [], archived: [] };
        (th.state.archived ? e.archived : e.active).push(th.ref.id);
      }
      for (const e of Object.values(projects)) { e.active.sort(); e.archived.sort(); }
      // Each environment (D3): its state and links, and the Codex threads that run in it.
      const environments = {};
      for (const env of (await ctx.graph.list('Environment')).filter((x) => x.ref.provider === NATIVE)) environments[`${env.ref.type}:${env.ref.id}`] = { state: env.state, links: env.links, threads: [] };
      for (const th of (await ctx.graph.list('Thread')).filter((x) => x.ref.provider === NATIVE && x.links?.environment)) environments[`${th.links.environment.type}:${th.links.environment.id}`]?.threads.push(th.ref.id);
      await fs.writeFile(path.join(files, 'census.json'), `${JSON.stringify({ at: new Date().toISOString(), observedThreads: threads.length, types, projects, environments }, null, 2)}\n`);
      ctx.log.info('census written', { types: Object.keys(types).length });
    } catch (e) {
      ctx.log.warn('census failed', { message: String(e?.message ?? e) });
    } finally {
      for (const s of subs) s.dispose();
      running = false;
    }
  }
  /** QA: answer the newest pending native approval with its option that approves once (or always: the user is asked first, R17), or with
   *  its decline (breadth.md D2, D3; graph-integrity G1.6). The trigger `answer` names any option by id: `{"option": "<id>"}`. */
  async function act(operation, option = null) {
    const pending = (await ctx.graph.list('Approval', { status: 'pending' })).filter((r) => r.ref.provider === NATIVE).sort((a, b) => (b.state.askedAt ?? 0) - (a.state.askedAt ?? 0));
    const target = pending[0];
    const options = target?.state.options ?? [];
    const chosen = option ?? (operation === 'deny' ? options.find((o) => o.kind === 'deny')
      : options.find((o) => o.kind === 'approve' && (o.scope ?? 'once') === (operation === 'approve-always' ? 'always' : 'once')))?.id;
    const out = target && chosen ? await ctx.graph.invoke(target.ref, 'answer', [chosen]) : { status: target ? 'no such option' : 'none' };
    await fs.appendFile(path.join(files, 'act.log'), `${JSON.stringify({ t: new Date().toISOString(), operation, option: chosen ?? null, options: options.map((o) => o.id), request: target?.ref ?? null, type: target?.ref.type ?? null, outcome: out })}\n`);
  }
  /** QA: a project operation through the graph (breadth.md D3): `project-<op>` holds `{"id": ..., "name"?: ...}`. */
  async function projectAct(op, body) {
    const req = JSON.parse(body);
    const ref = { type: 'LocalProject', provider: NATIVE, id: String(req.id) };
    const out = await ctx.graph.invoke(ref, op, op === 'rename' ? [String(req.name)] : []);
    await fs.appendFile(path.join(files, 'act.log'), `${JSON.stringify({ t: new Date().toISOString(), operation: op, project: ref, outcome: out })}\n`);
  }
  const take = async (f) => { try { await fs.rm(path.join(files, f)); return true; } catch { return false; } };
  const takeBody = async (f) => { try { const b = await fs.readFile(path.join(files, f), 'utf8'); await fs.rm(path.join(files, f)); return b; } catch { return null; } };
  // The projects' and files' named events (added, opened, renamed, removed; changed, deleted), as they come.
  const logEvent = (m) => {
    if (m.type !== 'delta' || m.event?.kind !== 'event') return;
    // its payload (cut at 1500 characters) and times (graph-integrity G1.3: the store's and the source's)
    const payload = m.event.payload === undefined || m.event.payload === null ? undefined : JSON.stringify(m.event.payload).slice(0, 1500);
    fs.appendFile(path.join(files, 'events.log'), `${JSON.stringify({ t: new Date().toISOString(), name: m.event.name, ref: m.event.ref,
      ...(payload ? { payload } : {}), ...(m.event.observedAt ? { observedAt: m.event.observedAt } : {}), ...(m.event.sourceAt ? { sourceAt: m.event.sourceAt } : {}) })}\n`).catch(() => {});
  };
  const typeViews = ['Project', 'File', 'ExternalApp', 'Repository', 'Environment', 'Instructions', 'Command', 'Setting', 'Theme', 'App', 'Account', 'Usage', 'Thread', 'QueuedMessage', 'Draft', 'ToolServer', 'Tool', 'Plugin', 'Skill', 'Shortcut', 'Automation', 'Notification', 'ChangeSet', 'FileChange', 'Comment', 'Review', 'Finding', 'PullRequest', 'Terminal', 'BrowserTab', 'ComputerUseSession', 'CodexMods', 'Mod', 'Operation', 'Turn', 'Step', 'Request', 'Message', 'Model', 'Agent', 'Environment'].map((type) => ctx.graph.subscribe({ type, depth: 'core' }, logEvent));
  /** QA (D3): a folder or file operation (`file-open`, `file-reveal`, `folder-reveal` hold `{"path"}`), and `observe-folder` (`{"path"}`):
   *  observe a folder's files from now on, so the provider reads and watches it; what it lists goes to files/folder.json. */
  const observed = new Map();
  const rules = new Map();   // the rules the `rule` trigger put, by id
  async function fileAct(name, body) {
    const req = JSON.parse(body);
    const p = String(req.path);
    if (name === 'app-open' || name === 'app-set-computer-use') {
      const ref = { type: 'ExternalApp', provider: NATIVE, id: String(req.id) };
      const out = name === 'app-open'
        ? await ctx.graph.invoke(ref, 'open', [req.path.startsWith('/') ? { type: req.kind === 'file' ? 'File' : 'Folder', provider: NATIVE, id: req.path } : req.path])
        : await ctx.graph.invoke(ref, 'setComputerUse', [String(req.level)]);
      await fs.appendFile(path.join(files, 'act.log'), `${JSON.stringify({ t: new Date().toISOString(), operation: name, ref, outcome: out })}\n`);
      return;
    }
    if (name === 'git') {   // {"projectId", "op": "createBranch" | "switchBranch" | "branch", "name"}
      const repo = { type: 'GitRepository', provider: NATIVE, id: String(req.projectId) };
      const out = req.op === 'createBranch' ? await ctx.graph.invoke(repo, 'createBranch', [String(req.name)])
        : req.op === 'switchBranch' ? await ctx.graph.invoke(repo, 'switchBranch', [{ type: 'Branch', provider: NATIVE, id: `${req.projectId}:${req.name}` }])
          : { status: 'none' };
      const r = await ctx.graph.resolve(repo);
      const branches = (await ctx.graph.related(repo, 'branches')).map((b) => b.state);
      await fs.appendFile(path.join(files, 'act.log'), `${JSON.stringify({ t: new Date().toISOString(), operation: `git ${req.op}`, outcome: out, repository: r?.state, current: r?.links?.currentBranch?.id, branches })}\n`);
      return;
    }
    if (name === 'instructions-edit' || name === 'instructions-open') {   // {"path", "text"?}
      const ref = { type: 'Instructions', provider: NATIVE, id: p };
      const out = name === 'instructions-edit' ? await ctx.graph.invoke(ref, 'edit', [{ parts: [{ kind: 'text', text: String(req.text) }] }]) : await ctx.graph.invoke(ref, 'open', []);
      await fs.appendFile(path.join(files, 'act.log'), `${JSON.stringify({ t: new Date().toISOString(), operation: name, ref, outcome: out, state: (await ctx.graph.resolve(ref))?.state ?? null })}\n`);
      return;
    }
    if (name === 'list') {   // {"type", "where"?, "observe"?: {"type", "id"}}: that type's native instances (that a where keeps: graph-integrity G3.5, a mod's value on a chat), after observing a ref for 3 s when given
      if (req.observe) { const v = ctx.graph.subscribe({ ref: { type: String(req.observe.type), provider: NATIVE, id: String(req.observe.id) } }, () => {}); await sleep(3000); v.dispose(); }
      const provider = typeof req.provider === 'string' ? req.provider : NATIVE;
      const list = (await ctx.graph.list(String(req.type), req.where && typeof req.where === 'object' ? req.where : undefined)).filter((x) => x.ref.provider === provider).map((x) => ({ ref: x.ref, state: x.state, links: x.links, ...(x.attached ? { attached: x.attached } : {}) }));
      await fs.writeFile(path.join(files, 'list.json'), `${JSON.stringify({ at: new Date().toISOString(), type: req.type, instances: list }, null, 2)}\n`);
      return;
    }
    if (name === 'related') {   // {"ref", "relation"}: an instance's relation (a thread's presentations, a Window's children), with links
      const list = await ctx.graph.related(req.ref, String(req.relation));
      const out = (Array.isArray(list) ? list : list ? [list] : []).map((x) => ({ ref: x.ref, state: x.state, links: x.links, ...(x.attached ? { attached: x.attached } : {}) }));
      await fs.writeFile(path.join(files, 'related.json'), `${JSON.stringify({ at: new Date().toISOString(), ref: req.ref, relation: req.relation, instances: out }, null, 2)}\n`);
      return;
    }
    if (name === 'subscribe') {   // {"ref", "depth"?, "ms"?}: one instance view (as a realm's replica opens one): what it delivered in `ms`
      const got = [];
      const view = ctx.graph.subscribe({ ref: req.ref, ...(req.depth ? { depth: req.depth } : {}) }, (msg) => { got.push({ t: Date.now(), type: msg.type, items: (msg.items ?? []).map((x) => ({ ref: x.ref, gone: x.gone === true })), event: msg.event ? { kind: msg.event.kind, ref: msg.event.ref ?? msg.event.instance?.ref, ...(msg.event.name ? { name: msg.event.name, payload: msg.event.payload ?? null } : {}) } : undefined }); return true; });
      await new Promise((r) => setTimeout(r, Math.min(Number(req.ms) || 3000, 15000)));
      view.dispose?.();
      await fs.writeFile(path.join(files, 'subscribe.json'), `${JSON.stringify({ at: new Date().toISOString(), ref: req.ref, messages: got }, null, 2)}\n`);
      return;
    }
    if (name === 'ui-read') {   // {"type"?, "window"?, "subject"?}: what is shown, through ctx.ui.read (03's generic read)
      const list = await ctx.ui._read(req);
      await fs.writeFile(path.join(files, 'ui-read.json'), `${JSON.stringify({ at: new Date().toISOString(), query: req, instances: list.map((x) => ({ ref: x.ref, state: x.state, links: x.links })) }, null, 2)}\n`);
      return;
    }
    if (name === 'parts') {   // {"presentation", "slot"?}: the app's own parts of a presentation on this build (ui.parts, layouts WL1)
      const list = await ctx.ui.parts(req.presentation, req.slot ? { slot: req.slot } : undefined);
      await fs.writeFile(path.join(files, 'parts.json'), `${JSON.stringify({ at: new Date().toISOString(), query: req, parts: list }, null, 2)}\n`);
      return;
    }
    if (name === 'rule') {   // {"op": "hide" | "decorate" | "default" | "order" | "reorder" | "update" | "remove", "id", "presentation"?, ...descriptor} (default: ctx.graph.defaults; order: ctx.ui.sidebar.order): one rule, put, changed or taken away while the app is idle (layouts D3)
      const { op, id, presentation, ...desc } = req;
      let out;
      if (op === 'remove') { const h = rules.get(id); rules.delete(id); out = h ? await h.dispose() : false; } else if (op === 'update') out = await rules.get(id)?.update(desc) ?? false;
      else {
        await rules.get(id)?.dispose();
        const h = op === 'hide' ? ctx.ui.hide(presentation, { id, ...desc }) : op === 'default' ? ctx.graph.defaults({ id, ...desc })
          : op === 'order' ? ctx.ui.sidebar.order({ id, ...desc }) : op === 'reorder' ? ctx.ui.reorder(presentation, { id, ...desc }) : ctx.ui.decorate(presentation, { id, ...desc });
        rules.set(id, h);
        out = { accepted: await h.accepted, unsupported: h.unsupported ?? [] };
      }
      await fs.appendFile(path.join(files, 'act.log'), `${JSON.stringify({ t: new Date().toISOString(), operation: `rule ${op} ${id}`, outcome: out })}\n`);
      return;
    }
    if (name === 'ui-act') {   // {"ref", "op", "args"?}: an operation on a presentation through ctx.ui.act (03's generic act)
      const out = await ctx.ui._act(req.ref, String(req.op), Array.isArray(req.args) ? req.args : []);
      await fs.appendFile(path.join(files, 'act.log'), `${JSON.stringify({ t: new Date().toISOString(), operation: `ui.act ${req.ref?.type}.${req.op}`, ref: req.ref, outcome: out })}\n`);
      return;
    }
    if (name === 'ask') {   // a ui.ask spec ({subject, purpose, title, message, actions, until?}): asked, then its result logged when it settles (E7.6c)
      const t0 = new Date().toISOString();
      await fs.appendFile(path.join(files, 'act.log'), `${JSON.stringify({ t: t0, operation: 'ui.ask asked', purpose: req.purpose })}\n`);
      ctx.ui.ask(req).then((result) => fs.appendFile(path.join(files, 'act.log'), `${JSON.stringify({ t: new Date().toISOString(), operation: 'ui.ask', asked: t0, result })}\n`),
        (e) => fs.appendFile(path.join(files, 'act.log'), `${JSON.stringify({ t: new Date().toISOString(), operation: 'ui.ask', asked: t0, error: String(e?.message ?? e) })}\n`));
      return;
    }
    if (name === 'invoke') {   // {"type", "id", "op", "args"?, "provider"?, "automatic"?}: any granted operation on a native instance (or another provider's)
      const ref = { type: String(req.type), provider: typeof req.provider === 'string' ? req.provider : NATIVE, id: String(req.id) };
      const out = await ctx.graph.invoke(ref, String(req.op), Array.isArray(req.args) ? req.args : [], ...(typeof req.automatic === 'string' ? [{ automatic: req.automatic }] : []));
      await fs.appendFile(path.join(files, 'act.log'), `${JSON.stringify({ t: new Date().toISOString(), operation: `invoke ${req.type}.${req.op}`, ref, outcome: out })}\n`);
      return;
    }
    if (name === 'action-run') {   // {"id", "thread"?}
      const ref = { type: 'ProjectAction', provider: NATIVE, id: String(req.id) };
      const out = await ctx.graph.invoke(ref, 'run', req.thread ? [{ thread: { type: 'CodexThread', provider: NATIVE, id: String(req.thread) } }] : []);
      await fs.appendFile(path.join(files, 'act.log'), `${JSON.stringify({ t: new Date().toISOString(), operation: name, ref, outcome: out })}\n`);
      return;
    }
    if (name === 'list-actions') {
      const list = (await ctx.graph.list('ProjectAction')).filter((x) => x.ref.provider === NATIVE).map((x) => ({ id: x.ref.id, state: x.state, links: x.links }));
      await fs.writeFile(path.join(files, 'actions.json'), `${JSON.stringify({ at: new Date().toISOString(), actions: list }, null, 2)}\n`);
      return;
    }
    if (name === 'list-instructions') {
      const list = (await ctx.graph.list('Instructions')).filter((x) => x.ref.provider === NATIVE).map((x) => ({ id: x.ref.id, state: x.state, links: x.links }));
      await fs.writeFile(path.join(files, 'instructions.json'), `${JSON.stringify({ at: new Date().toISOString(), instructions: list }, null, 2)}\n`);
      return;
    }
    if (name === 'list-apps') {
      const apps = (await ctx.graph.list('ExternalApp')).map((x) => ({ id: x.ref.id, state: x.state }));
      await fs.writeFile(path.join(files, 'apps.json'), `${JSON.stringify({ at: new Date().toISOString(), apps }, null, 2)}\n`);
      return;
    }
    if (name === 'observe-folder') {
      const ref = { type: 'Folder', provider: NATIVE, id: p };
      if (!observed.has(p)) observed.set(p, ctx.graph.subscribe({ ref, relation: 'files' }, () => {}));
      await sleep(3000);
      const list = async (relation) => (await ctx.graph.related(ref, relation)).map((x) => ({ id: x.ref.id, state: x.state }));
      await fs.writeFile(path.join(files, 'folder.json'), `${JSON.stringify({ at: new Date().toISOString(), folder: p, files: await list('files'), folders: await list('folders') }, null, 2)}\n`);
      return;
    }
    const [kind, op] = name.split('-');
    const ref = { type: kind === 'file' ? 'File' : 'Folder', provider: NATIVE, id: p };
    const out = await ctx.graph.invoke(ref, op, []);
    await fs.appendFile(path.join(files, 'act.log'), `${JSON.stringify({ t: new Date().toISOString(), operation: name, ref, outcome: out })}\n`);
  }
  census();
  let presentations = null;
  const timer = setInterval(async () => {
    if (await take('run')) census();
    for (const op of ['approve', 'approve-always', 'deny']) if (await take(op)) act(op).catch((e) => ctx.log.warn('act failed', { message: String(e?.message ?? e) }));
    { const body = await takeBody('answer'); if (body !== null) act('answer', JSON.parse(body).option).catch((e) => ctx.log.warn('act failed', { message: String(e?.message ?? e) })); }
    for (const op of ['rename', 'remove', 'reveal']) {
      const body = await takeBody(`project-${op}`);
      if (body !== null) projectAct(op, body).catch((e) => ctx.log.warn('project act failed', { message: String(e?.message ?? e) }));
    }
    // The presentations' named events (S10), only while asked: their view sees every presentation the windows report.
    if (await take('presentations-on') && !presentations) presentations = ctx.graph.subscribe({ type: 'Presentation' }, logEvent);
    if (await take('presentations-off') && presentations) { presentations.dispose(); presentations = null; }
    for (const name of ['file-open', 'file-reveal', 'folder-reveal', 'observe-folder', 'app-open', 'app-set-computer-use', 'list-apps', 'git', 'instructions-edit', 'instructions-open', 'list-instructions', 'action-run', 'list-actions', 'invoke', 'list', 'related', 'subscribe', 'ui-read', 'ui-act', 'parts', 'rule', 'ask']) {
      const body = await takeBody(name);
      if (body !== null) fileAct(name, body).catch((e) => ctx.log.warn('file act failed', { message: String(e?.message ?? e) }));
    }
  }, 1000);
  return () => { clearInterval(timer); presentations?.dispose(); for (const v of [...typeViews, ...observed.values(), ...rules.values()]) v.dispose(); };
}

export default { host };
