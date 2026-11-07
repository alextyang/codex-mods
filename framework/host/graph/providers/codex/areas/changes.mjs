// The changes of a turn and a thread, from protocol fileChange items (breadth D7). Mutations use the app's git worker, never a second git
// implementation. Undo runs the turn's patches backwards; reapply runs them forwards. The area remembers only the undo state it made.
import path from 'node:path';
import { refs, changedPath } from '../map.mjs';

export const realizes = {
  types: ['ChangeSet', 'FileChange', 'Hunk'],
  operations: { ChangeSet: ['revert', 'apply', 'patch'], FileChange: ['viewDiff', 'openFile', 'openIn', 'revert', 'apply', 'diff'], Hunk: ['revert', 'apply'], FileEdit: ['openDiff', 'openFile'] },
  supports: { FileChange: ['from', 'diff'], ChangeSet: ['patch'] },
  events: { ChangeSet: ['changed', 'reverted', 'applied'], FileChange: ['changed'] },
  links: { ChangeSet: ['thread', 'turn', 'environment'], FileChange: ['changeSet', 'file'], Hunk: ['fileChange'], CodexThread: ['changes'], CodexTurn: ['changes'] },
};

const linesOf = (text) => { const lines = String(text ?? '').split('\n'); if (lines.at(-1) === '') lines.pop(); return lines; };
const newline = (text) => text.endsWith('\n') ? text : `${text}\n`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const refused = (reason, message) => ({ status: 'refused', reason, message });
const fileKind = (c) => c.kind?.type === 'add' ? 'added' : c.kind?.type === 'delete' ? 'deleted'
  : c.kind?.type === 'update' && c.kind.move_path ? 'renamed' : 'modified';

/** Unified hunk ranges and the exact text to send back to git. Header counts omitted by git mean one line. */
export function parseHunks(diff) {
  const out = [];
  let hunk = null, before = 0, after = 0;
  for (const line of linesOf(diff)) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/.exec(line);
    if (m) {
      hunk = { before: { start: Number(m[1]), lines: Number(m[2] ?? 1) }, after: { start: Number(m[3]), lines: Number(m[4] ?? 1) }, text: `${line}\n` };
      out.push(hunk);
      before = hunk.before.lines; after = hunk.after.lines;
    } else if (hunk && (before > 0 || after > 0 || line.startsWith('\\ No newline'))) {
      if (line.startsWith(' ')) { before -= 1; after -= 1; }
      else if (line.startsWith('-')) before -= 1;
      else if (line.startsWith('+')) after -= 1;
      else if (!line.startsWith('\\ No newline')) { hunk = null; continue; }
      hunk.text += `${line}\n`;
    }
  }
  return out;
}

export function countLines(change) {
  const lines = linesOf(change.diff);
  if (change.kind?.type === 'add') return { added: lines.length, removed: 0 };
  if (change.kind?.type === 'delete') return { added: 0, removed: lines.length };
  return { added: lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length,
    removed: lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length };
}

/** Paths in generated headers are relative to cwd when they name a file inside it. Complete patches keep their own headers. */
export function patchOf(change, cwd, { reverse: _reverse } = {}) {
  const diff = String(change.diff ?? '');
  if (diff.startsWith('diff --git ') || diff.startsWith('--- ')) return newline(diff);
  const rel = (p) => {
    if (path.isAbsolute(p) && typeof cwd === 'string' && path.isAbsolute(cwd)) {
      const r = path.relative(cwd, p);
      if (r && r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r)) return r;
    }
    return p;
  };
  const before = rel(change.path), after = rel(changedPath(change) ?? change.path);
  const lines = linesOf(diff), n = lines.length;
  if (change.kind?.type === 'add') return `--- /dev/null\n+++ b/${after}\n@@ -0,0 +1,${n} @@\n${lines.map((l) => `+${l}\n`).join('')}`;
  if (change.kind?.type === 'delete') return `--- a/${before}\n+++ /dev/null\n@@ -1,${n} +0,0 @@\n${lines.map((l) => `-${l}\n`).join('')}`;
  if (change.kind?.type === 'update' && change.kind.move_path) {
    const rename = `diff --git a/${before} b/${after}\nrename from ${before}\nrename to ${after}\n`;
    return diff.trim() ? newline(`${rename}--- a/${before}\n+++ b/${after}\n${diff}`) : rename;
  }
  return newline(`--- a/${before}\n+++ b/${after}\n${diff}`);
}

const hunksOf = (c, cwd) => parseHunks(patchOf(c, cwd));

/** Entries are the turn's ordered changes, each `{threadId, turnId, cwd, environment, change, state}`. An entry without `change` carries
 *  the same parent facts for an empty turn. Thread entries are in turn order, oldest first. */
export function changeSetData(scope, id, entries) {
  const set = refs.changeSet(scope, id), first = entries[0] ?? {};
  const files = new Map();
  for (const e of entries) {
    const c = e.change, p = changedPath(c);
    if (!p) continue;
    const counts = countLines(c), kind = fileKind(c), previous = files.get(p);
    const latest = scope === 'thread' && previous?.turnId !== e.turnId;
    const nextKind = !previous || latest || kind === 'deleted' ? kind : previous.kind;
    files.set(p, { path: p, kind: nextKind,
      ...(nextKind === 'renamed' ? { from: !previous || latest ? c.path : previous.from } : {}),
      added: (previous?.added ?? 0) + counts.added, removed: (previous?.removed ?? 0) + counts.removed,
      state: e.state ?? 'applied', turnId: e.turnId,
      hunks: [...(previous?.hunks ?? []), ...hunksOf(c, e.cwd)], cwd: e.cwd });
  }
  const rows = [...files.values()], states = new Set(rows.map((f) => f.state));
  const changeSet = { ref: set, state: { fileCount: rows.length, added: rows.reduce((n, f) => n + f.added, 0), removed: rows.reduce((n, f) => n + f.removed, 0),
    state: states.size > 1 ? 'mixed' : rows[0]?.state ?? 'applied' },
  links: { thread: refs.thread(scope === 'thread' ? id : first.threadId), turn: scope === 'turn' ? refs.turn(id) : null, environment: first.environment ?? null } };
  const out = { changeSet, files: [], hunks: [] };
  for (const f of rows) {
    const ref = refs.fileChange(set.id, f.path);
    out.files.push({ ref, state: { path: f.path, kind: f.kind, ...(f.kind === 'renamed' ? { from: f.from } : {}), added: f.added, removed: f.removed, state: f.state },
      links: { changeSet: set, file: refs.file(path.isAbsolute(f.path) || !f.cwd ? f.path : path.resolve(f.cwd, f.path)) } });
    out.hunks.push(...f.hunks.map((h, index) => ({ ref: refs.hunk(ref.id, index), state: { before: h.before, after: h.after, state: f.state }, links: { fileChange: ref } })));
  }
  return out;
}

export function types(feed) {
  const writes = () => Object.fromEntries(['revert', 'apply'].map((op) => [op, {
    effect: 'external', approval: ({ ref }) => feed().prompt(op, ref), handler: ({ ref }) => feed().mutate(op, ref),
  }]));
  return {
    // the unified diff of what its turn changed (content: a grant must name it)
    ChangeSet: { operations: { ...writes(), patch: { effect: 'none', handler: ({ ref }) => feed().diff(ref) } } }, Hunk: { operations: writes() },
    FileChange: { operations: { ...writes(), diff: { effect: 'none', handler: ({ ref }) => feed().diff(ref) },
      viewDiff: { effect: 'local', handler: ({ ref }) => feed().open('view-diff', ref) },
      openFile: { effect: 'local', handler: ({ ref }) => feed().open('open-file', ref) },
      openIn: { effect: 'external', handler: ({ ref, args: [app] }) => feed().open('open-in', ref, app) },
    } },
    FileEdit: { operations: {
      openDiff: { effect: 'local', handler: ({ ref }) => feed().open('view-diff', ref) },
      openFile: { effect: 'local', handler: ({ ref }) => feed().open('open-file', ref) },
    } },
  };
}

export function createFeed(ctx) {
  const turns = new Map(), sets = new Map(), pending = new Map();
  let disposed = false;
  const rowsOf = (data) => [data.changeSet, ...data.files, ...data.hunks];
  const resident = (ref) => ref ? ctx.resident(ref) : null;
  const threadOf = (turnId) => turns.get(turnId)?.threadId ?? ctx.resident(refs.turn(turnId))?.links.thread?.id;

  function entriesOf(t) {
    const meta = { threadId: t.threadId, turnId: t.id, cwd: ctx.cwdOf(t.threadId), environment: ctx.resident(refs.thread(t.threadId))?.links.environment ?? null };
    const entries = [];
    for (const item of t.items.values()) {
      if (item.status === 'failed' || item.status === 'declined') continue;
      const proposed = item.status === 'inProgress' && ctx.graph.list('EditApproval').some((a) => !a.gone && a.ref.provider === refs.agent().provider
        && a.state.status === 'pending' && a.ref.id.startsWith(`${t.threadId}:${item.id}:`) && a.links.turn?.id === t.id);
      for (const change of item.changes ?? []) if (changedPath(change)) entries.push({ ...meta, change, state: t.states.get(changedPath(change)) ?? (proposed ? 'proposed' : 'applied') });
    }
    return entries.length ? entries : [meta];
  }
  function applyLinks() {
    if (disposed) return;
    for (const t of turns.values()) {
      const turn = ctx.resident(refs.turn(t.id)), set = refs.changeSet('turn', t.id);
      if (turn && !same(turn.links.changes, set)) ctx.handle.update(turn.ref, { links: { changes: set } });
      const thread = ctx.resident(refs.thread(t.threadId)), all = refs.changeSet('thread', t.threadId);
      if (thread && !same(thread.links.changes, all)) ctx.handle.update(thread.ref, { links: { changes: all } });
    }
  }
  function put(scope, id, entries, sync) {
    const data = changeSetData(scope, id, entries), key = data.changeSet.ref.id, previous = sets.get(key);
    const before = new Map(previous ? rowsOf(previous.data).map((d) => [d.ref.id, d]) : []);
    for (const d of rowsOf(data)) {
      if (!same(before.get(d.ref.id), d) || !ctx.resident(d.ref)) ctx.handle.put(d.ref, { state: d.state, links: d.links });
      before.delete(d.ref.id);
    }
    for (const d of before.values()) if (ctx.resident(d.ref)) ctx.handle.remove(d.ref);
    sets.set(key, { data, entries });
    if (!sync && previous && !same(previous.entries, entries)) {
      ctx.emitEvent(data.changeSet.ref, 'changed');
      for (const f of data.files) {
        const old = previous.data.files.find((x) => x.ref.id === f.ref.id)?.state;
        if (!old || old.added !== f.state.added || old.removed !== f.state.removed || old.state !== f.state.state) ctx.emitEvent(f.ref, 'changed');
      }
    }
  }
  function publish(t, sync = false) {
    if (disposed) return;
    put('turn', t.id, entriesOf(t), sync);
    const all = [...turns.values()].filter((x) => x.threadId === t.threadId).sort((a, b) => a.startedAt - b.startedAt);
    put('thread', t.threadId, all.flatMap(entriesOf), sync);
    applyLinks();
  }
  function removeThread(threadId) {
    for (const [key, value] of sets) if (value.data.changeSet.links.thread.id === threadId) {
      for (const d of rowsOf(value.data).reverse()) if (ctx.resident(d.ref)) ctx.handle.remove(d.ref);
      sets.delete(key);
    }
    for (const [id, t] of turns) if (t.threadId === threadId) turns.delete(id);
  }
  function prune() { for (const t of turns.values()) if (!ctx.resident(refs.thread(t.threadId))) removeThread(t.threadId); }
  function signatures(items) {
    const out = new Map();
    for (const item of items.values()) for (const c of item.changes ?? []) {
      const p = changedPath(c);
      if (p) out.set(p, [...(out.get(p) ?? []), { itemId: item.id, change: c }]);
    }
    return out;
  }
  function learn(threadId, turn, item) {
    if (disposed) return;
    prune();
    if (!threadId || !ctx.resident(refs.thread(threadId))) return;
    const old = turns.get(turn.id), t = old ?? { id: turn.id, threadId, startedAt: ctx.resident(refs.turn(turn.id))?.state.startedAt ?? 0, items: new Map(), states: new Map() };
    if (typeof turn.startedAt === 'number') t.startedAt = turn.startedAt * 1000;
    const before = signatures(t.items);
    if (item) t.items.set(item.id, item);
    else if (Array.isArray(turn.items) && turn.itemsView !== 'notLoaded') t.items = new Map(turn.items.filter((i) => i.type === 'fileChange').map((i) => [i.id, i]));
    const after = signatures(t.items);
    for (const p of new Set([...before.keys(), ...after.keys()])) if (!same(before.get(p), after.get(p))) t.states.delete(p);
    turns.set(t.id, t);
    publish(t, !old);
  }
  function target(ref) {
    const instance = resident(ref);
    const file = ref.type === 'Hunk' ? resident(instance?.links.fileChange) : instance;
    const set = ref.type === 'ChangeSet' ? instance : resident(file?.links.changeSet);
    if (!set) return null;
    const turn = set.links.turn ? turns.get(set.links.turn.id) : null;
    return { set, file, turn, path: ref.type === 'ChangeSet' ? null : file.state.path,
      hunk: ref.type === 'Hunk' ? Number(ref.id.slice(ref.id.lastIndexOf('#') + 1)) : null };
  }
  function plan(op, ref) {
    const at = target(ref);
    if (!at?.turn) return { no: refused('unsupported', "undo a turn's changes: each turn has its own") };
    const wanted = op === 'revert' ? 'applied' : 'reverted', entries = entriesOf(at.turn);
    const byPath = new Map(sets.get(refs.changeSet('turn', at.turn.id).id)?.data.files.map((f) => [f.state.path, f.state.state]));
    let changes = entries.filter((e) => e.change && (!at.path || changedPath(e.change) === at.path) && byPath.get(changedPath(e.change)) === wanted);
    if (at.hunk !== null) {
      const hunks = changes.flatMap((e) => hunksOf(e.change, e.cwd).map((h) => ({ ...e, hunk: h })));
      changes = hunks[at.hunk] ? [hunks[at.hunk]] : [];
    }
    if (!changes.length) return { no: refused('unsupported', op === 'revert' ? 'nothing is applied' : 'nothing is reverted') };
    if (!changes.every((e) => typeof e.cwd === 'string' && path.isAbsolute(e.cwd))) return { no: refused('unavailable', 'the thread has no working directory') };
    return { ...at, changes: op === 'revert' ? changes.reverse() : changes };
  }
  async function appOp(op, args) {
    const r = await ctx.mainOp(op, args);
    if (r.ok) return null;
    if (r.refused) return refused('unavailable', r.error);
    throw new Error(r.error);
  }

  const graphSub = ctx.graph.onEvent((e) => {
    if (disposed || e.ref?.provider !== refs.agent().provider || !['added', 'changed'].includes(e.kind)) return;
    if (ctx.graph.type(e.ref.type)?.concept === 'Turn') {
      const turn = pending.get(e.ref.id), threadId = threadOf(e.ref.id);
      if (turn && threadId) { pending.delete(e.ref.id); learn(threadId, turn); }
      applyLinks();
    } else if (e.ref.type === 'CodexThread') applyLinks();
    else if (e.ref.type === 'EditApproval') {
      const t = turns.get(e.instance?.links.turn?.id);
      if (t) publish(t);
    }
  });

  return {
    start() { prune(); applyLinks(); },
    /**
     * FileChange.diff, ChangeSet.patch: the patches as unified diff text (a file's, or every file's), in the order they ran: a turn's, or
     * (the chat's own set) every turn's of its chat.
     */
    diff(ref) {
      const at = target(ref);
      const threadId = at?.set.ref.id.startsWith('thread:') ? at.set.links.thread?.id : null;
      const ran = at?.turn ? [at.turn] : threadId ? [...turns.values()].filter((x) => x.threadId === threadId).sort((a, b) => a.startedAt - b.startedAt) : [];
      if (!ran.length) return refused('unsupported', 'these changes have no patches here');
      return ran.flatMap(entriesOf).filter((e) => e.change && (!at.path || changedPath(e.change) === at.path)).map((e) => patchOf(e.change, e.cwd)).join('');
    },
    notified(method, p) {
      if (disposed) return;
      if (method === 'thread/deleted') { removeThread(p.threadId); return; }
      if ((method === 'item/completed' || method === 'item/started') && p.item?.type === 'fileChange') learn(p.threadId, { id: p.turnId }, p.item);
      if (method === 'item/fileChange/patchUpdated') {
        const old = turns.get(p.turnId)?.items.get(p.itemId);
        learn(p.threadId, { id: p.turnId }, { ...old, id: p.itemId, type: 'fileChange', status: old?.status ?? 'inProgress', changes: p.changes });
      }
    },
    responded(method, result) {
      if (disposed) return;
      if (method === 'thread/read' || method === 'thread/resume') for (const turn of result.thread?.turns ?? []) learn(result.thread.id, turn);
      if (method === 'thread/turns/list') for (const turn of [...(result.data ?? [])].reverse()) {
        const threadId = threadOf(turn.id);
        if (threadId) learn(threadId, turn);
        else pending.set(turn.id, turn); // The core puts a newly loaded turn after the answer reaches the areas.
      }
      if (['thread/turns/list', 'thread/read', 'thread/resume', 'thread/list'].includes(method)) { prune(); applyLinks(); }
    },
    observe(ref, concept) {
      if (!['ChangeSet', 'FileChange', 'Hunk'].includes(concept)) return undefined;
      if (disposed) return Promise.resolve();
      const at = target(ref), match = /^(thread|turn):([^:]+)/.exec(ref.id);
      const threadId = at?.set.links.thread.id ?? (match?.[1] === 'thread' ? match[2] : match ? threadOf(match[2]) : null);
      return threadId ? ctx.loadThread(threadId).then(() => { prune(); applyLinks(); }) : Promise.resolve();
    },
    prompt(op, ref) {
      const p = plan(op, ref);
      if (p.no) return null;
      const object = ref.type === 'ChangeSet' ? `the changes of a turn in “${ctx.resident(refs.thread(p.turn.threadId))?.state.title ?? 'New thread'}”`
        : ref.type === 'FileChange' ? `the changes to ${p.path}` : `a change in ${p.path}`;
      return { action: `${op === 'revert' ? 'undo' : 'reapply'} ${object}`, detail: `It changes the files in ${p.changes[0].cwd} with git apply.` };
    },
    async mutate(op, ref) {
      const p = plan(op, ref);
      if (p.no) return p.no;
      const left = new Map();
      for (const e of p.changes) { const k = changedPath(e.change); left.set(k, (left.get(k) ?? 0) + 1); }
      let tried = 0, changed = false;
      try {
        for (const e of p.changes) {
          let diff = patchOf(e.change, e.cwd, { reverse: op === 'revert' });
          if (e.hunk) diff = diff.slice(0, diff.indexOf('@@')) + e.hunk.text;
          // Always atomic (git apply without --3way): these patches carry no blob ids for a 3-way merge, and --3way needs the path in the
          // index, so a file the agent created (untracked) would be skipped (21477, checked natively).
          const r = await appOp('apply-patch', { cwd: e.cwd, diff, revert: op === 'revert', atomic: true });
          if (r) { if (!tried) return r; throw new Error(r.message); }
          tried += 1;
          const k = changedPath(e.change), remaining = left.get(k) - 1;
          left.set(k, remaining);
          if (!remaining) { p.turn.states.set(k, op === 'revert' ? 'reverted' : 'applied'); changed = true; }
        }
      } finally { if (changed && !disposed) publish(p.turn); }
      if (!disposed) ctx.emitEvent(p.set.ref, op === 'revert' ? 'reverted' : 'applied');
      return null;
    },
    async open(op, ref, app) {
      const instance = ctx.resident(ref);
      const at = ref.type === 'FileEdit' ? { path: instance?.links.file?.id, threadId: resident(instance?.links.turn)?.links.thread?.id }
        : { path: instance?.state.path, threadId: target(ref)?.set.links.thread.id };
      const cwd = ctx.cwdOf(at.threadId);
      if (!at.path || !at.threadId || (!path.isAbsolute(at.path) && !cwd)) return refused('unavailable', 'the file has no thread or working directory');
      const absolute = path.isAbsolute(at.path) ? at.path : path.resolve(cwd, at.path);
      if (op === 'open-in') {
        if (!app || app.provider !== refs.agent().provider || app.type !== 'ExternalApp' || typeof app.id !== 'string' || !app.id.trim()) return refused('invalid', 'an ExternalApp of this provider is needed');
        return appOp(op, { path: absolute, appId: app.id });
      }
      return appOp(op, { threadId: at.threadId, path: absolute });
    },
    dispose() { disposed = true; graphSub.dispose(); turns.clear(); sets.clear(); pending.clear(); },
  };
}
