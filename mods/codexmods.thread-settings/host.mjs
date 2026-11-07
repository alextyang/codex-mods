// codexmods.thread-settings, host entry (GOAL.md goal 18). Single-file ESM, Node built-ins only.
//
// A chat's skills as settings of that chat. Each skill the chat can use gets a switch for that chat ("Use in this chat") and the
// parameters its SKILL.md declares (the `metadata.x-codexmods-settings` convention, README.md), as Setting instances this mod contributes to
// the chat's `settings` (graph-integrity G3: put when someone reads that relation), each defined by its Skill and grouped in a section of
// its own. Their values are kept in this mod's storage, one record per chat. Every message sent in a Codex chat carries that chat's skill
// choices to the agent, as the turn's additional context under this mod's name, while any of them differs from its default.
//
// Codex's own settings of a chat and every mod's chat-scope settings are in the same relation already (their providers put them); the
// renderer draws them all.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

const KINDS = new Set(['toggle', 'choice', 'text', 'number']);
const CONTROLS = { choice: new Set(['select', 'segmented']), number: new Set(['stepper', 'slider']), text: new Set(['line', 'area']) };
const KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const FILE_MAX = 1_048_576;
const PARAMS_MAX = 24;
const OPTIONS_MAX = 32;
const TEXT_MAX = 2000;
const CONTEXT_MAX = 8000;
const ENABLED = 'enabled';
const ENABLED_DECL = Object.freeze({ key: ENABLED, kind: 'toggle', default: true, title: 'Use in this chat' });
/** A skill's switch for a chat: titled by the skill, described by it. */
const switchOf = (skill) => { const d = textOf(skill.state?.description, 160); return { ...ENABLED_DECL, title: String(skill.state?.name ?? 'Skill').slice(0, 80), ...(d ? { description: d } : {}) }; };

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hash = (...parts) => createHash('sha256').update(parts.map(String).join('\u0000')).digest('hex').slice(0, 32);
const textOf = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** The JSON object written after `x-codexmods-settings:` in a SKILL.md's frontmatter (JSON is a YAML flow mapping), or null. */
export function declarationOf(file) {
  if (typeof file !== 'string' || !file.startsWith('---')) return null;
  const end = file.indexOf('\n---', 3);
  const front = end === -1 ? '' : file.slice(3, end);
  const at = front.search(/^[ \t]*x-codexmods-settings[ \t]*:/m);
  if (at === -1) return null;
  const open = front.indexOf('{', at);
  if (open === -1) return { error: 'x-codexmods-settings is not a JSON object' };
  let depth = 0, inString = false, escaped = false;
  for (let i = open; i < front.length; i++) {
    const c = front[i];
    if (inString) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') inString = false; continue; }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return { value: JSON.parse(front.slice(open, i + 1)) }; } catch (e) { return { error: `x-codexmods-settings is not valid JSON: ${e.message}` }; }
    }
  }
  return { error: 'x-codexmods-settings is not closed' };
}

/** A choice's options as `{value, label, description?}`, or null when they are not valid. */
function optionsOf(list) {
  if (!Array.isArray(list) || list.length === 0 || list.length > OPTIONS_MAX) return null;
  const out = [];
  for (const o of list) {
    const value = isObj(o) ? o.value : o;
    if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) return null;
    const label = isObj(o) ? textOf(o.label, 80) : String(value).slice(0, 80);
    if (!label || out.some((x) => String(x.value) === String(value))) return null;
    const description = isObj(o) ? textOf(o.description, 160) : null;
    out.push({ value, label, ...(description ? { description } : {}) });
  }
  return out;
}

/** A value for a declaration, as stored (a choice's option value), or undefined when it is not one. */
export function coerce(decl, v) {
  switch (decl.kind) {
    case 'toggle': return typeof v === 'boolean' ? v : undefined;
    case 'choice': { const o = decl.options.find((x) => String(x.value) === String(v)); return o ? o.value : undefined; }
    case 'text': return typeof v === 'string' && v.length <= TEXT_MAX ? v : undefined;
    case 'number': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
      if ((decl.min !== undefined && v < decl.min) || (decl.max !== undefined && v > decl.max)) return undefined;
      return v;
    }
    default: return undefined;
  }
}

/** One parameter's declaration, checked: the manifest's setting declaration, for the kinds a skill may use. */
function declOf(d) {
  if (!isObj(d) || typeof d.key !== 'string' || !KEY.test(d.key) || d.key === ENABLED) return { error: `a parameter needs a key (letters, digits, - and _; not "${ENABLED}")` };
  const title = textOf(d.title, 80);
  if (!title) return { error: `${d.key}: a title is needed` };
  if (!KINDS.has(d.kind)) return { error: `${d.key}: kind is one of ${[...KINDS].join(', ')}` };
  const decl = { key: d.key, kind: d.kind, title };
  const description = textOf(d.description, 300);
  if (description) decl.description = description;
  if (d.control !== undefined) {
    if (!CONTROLS[d.kind]?.has(d.control)) return { error: `${d.key}: control ${d.control} is not one of a ${d.kind}'s` };
    decl.control = d.control;
  }
  if (d.kind === 'choice') {
    decl.options = optionsOf(d.options);
    if (!decl.options) return { error: `${d.key}: a choice needs 1 to ${OPTIONS_MAX} options, each a value and a label` };
  }
  if (d.kind === 'number') {
    for (const k of ['min', 'max', 'step']) {
      if (d[k] === undefined) continue;
      if (typeof d[k] !== 'number' || !Number.isFinite(d[k])) return { error: `${d.key}: ${k} is a number` };
      decl[k] = d[k];
    }
    if (decl.min !== undefined && decl.max !== undefined && decl.min > decl.max) return { error: `${d.key}: min is above max` };
    const unit = textOf(d.unit, 24);
    if (unit) decl.unit = unit;
  }
  if (d.kind === 'text') { const placeholder = textOf(d.placeholder, 120); if (placeholder) decl.placeholder = placeholder; }
  const value = coerce(decl, d.default);
  if (value === undefined) return { error: `${d.key}: its default is not a valid ${d.kind}` };
  decl.default = value;
  return { decl };
}

/** A skill's parameters from its SKILL.md: `{params, error}`; a skill that declares none has none, and one with an error has none. */
export function parametersOf(file) {
  const found = declarationOf(file);
  if (!found) return { params: [], error: null };
  if (found.error) return { params: [], error: found.error };
  const v = found.value;
  if (!isObj(v) || v.version !== 1 || !Array.isArray(v.settings)) return { params: [], error: 'x-codexmods-settings needs {"version": 1, "settings": [...]}' };
  if (v.settings.length > PARAMS_MAX) return { params: [], error: `at most ${PARAMS_MAX} parameters` };
  const params = [];
  for (const d of v.settings) {
    const r = declOf(d);
    if (r.error) return { params: [], error: r.error };
    if (params.some((p) => p.key === r.decl.key)) return { params: [], error: `${r.decl.key}: declared twice` };
    params.push(r.decl);
  }
  return { params, error: null };
}

/** A Setting's state for a declaration and its value (each choice states its value, so a number or a boolean option keeps its type). */
function stateOf(decl, value) {
  const s = { title: decl.title, key: decl.key, value, default: decl.default,
    scope: 'thread', scopes: ['thread'], kind: decl.kind, overridden: !same(value, decl.default) };
  for (const k of ['description', 'control', 'min', 'max', 'step', 'unit', 'placeholder']) if (decl[k] !== undefined) s[k] = decl[k];
  if (decl.kind === 'choice') s.choices = decl.options.map((o) => ({ id: String(o.value), label: o.label, value: o.value, ...(o.description ? { description: o.description } : {}) }));
  return s;
}

/** The SKILL.md a skill's id names (an installed skill's id is its folder or its SKILL.md). */
const skillFile = (id) => (id.endsWith('/SKILL.md') ? id : `${id.replace(/\/+$/, '')}/SKILL.md`);

/** What the agent is told of a chat's skill choices, or null while each is its default. */
export function contextOf(skills) {
  const off = skills.filter((x) => x.values[ENABLED] === false).map((x) => x.name);
  const set = skills.filter((x) => x.values[ENABLED] !== false && x.params.length > 0);
  if (!off.length && !set.some((x) => x.params.some((p) => !same(x.values[p.key], p.default)))) return null;
  const lines = ['Skill settings for this chat, chosen by the user. They replace any earlier ones.'];
  if (off.length) lines.push(`- Do not use these skills in this chat unless the user names one: ${off.join(', ')}.`);
  for (const x of set) lines.push(`- ${x.name}: ${x.params.map((p) => `${p.key} = ${JSON.stringify(x.values[p.key])}`).join(', ')}.`);
  lines.push('Apply these values whenever you use these skills.');
  return lines.join('\n').slice(0, CONTEXT_MAX);
}

async function host(ctx) {
  const ref = (type, id) => ({ type, provider: ctx.mod.id, id });
  const index = new Map();     // Setting id -> {thread, skill, decl}
  const byThread = new Map();  // thread id -> the ids of the instances put for it
  const files = new Map();     // skill id -> {mtime, size, result}: SKILL.md read again only when it changes

  async function paramsOf(skill) {
    const path = skillFile(skill.ref.id);
    let st;
    try { st = await fs.stat(path); } catch { return { params: [], error: null }; }
    const seen = files.get(skill.ref.id);
    if (seen && seen.mtime === st.mtimeMs && seen.size === st.size) return seen.result;
    let result;
    if (!st.isFile() || st.size > FILE_MAX) result = { params: [], error: 'SKILL.md is not a file of at most 1 MB' };
    else {
      try { result = parametersOf(await fs.readFile(path, 'utf8')); } catch (e) { result = { params: [], error: `SKILL.md could not be read: ${e.code ?? e.message}` }; }
    }
    files.set(skill.ref.id, { mtime: st.mtimeMs, size: st.size, result });
    if (result.error) ctx.log.warn('a skill\'s parameters are not valid', { skill: skill.state?.name, error: result.error });
    return result;
  }

  /** The skills a chat can use: installed and on, everywhere or in the chat's project. */
  async function skillsOf(thread) {
    const project = thread?.links?.project?.id ?? null;
    const all = await ctx.graph.list('Skill');
    return all.filter((x) => x?.ref && !x.gone && x.state?.installed !== false && x.state?.enabled === true
      && (x.state?.scope !== 'project' || (project !== null && x.links?.project?.id === project)))
      .sort((a, b) => String(a.state?.name).localeCompare(String(b.state?.name)));
  }

  const storeKey = (threadId) => `chat/${hash(threadId)}`;
  const valueKey = (skillId, key) => hash(skillId, key);
  const valuesOf = async (threadId) => { const v = await ctx.storage.get(storeKey(threadId)); return isObj(v) ? v : {}; };

  /** A chat's skills with their parameters and the chat's values (each a stored value still valid, else its default). */
  async function choicesOf(threadRef) {
    const thread = await ctx.graph.resolve(threadRef);
    const stored = await valuesOf(threadRef.id);
    const out = [];
    for (const skill of await skillsOf(thread)) {
      const { params } = await paramsOf(skill);
      const values = {};
      for (const decl of [ENABLED_DECL, ...params]) {
        const v = stored[valueKey(skill.ref.id, decl.key)];
        values[decl.key] = v === undefined ? decl.default : (coerce(decl, v) ?? decl.default);
      }
      out.push({ skill, name: String(skill.state?.name ?? 'skill'), params, values });
    }
    return out;
  }

  let provider = null;
  /** Put this mod's settings for a Codex chat (asked when someone reads its `settings`); those of skills it no longer has go. */
  async function refresh(target) {
    if (!provider || target?.provider !== 'codex') return;
    const want = new Set();
    for (const x of await choicesOf(target)) {
      const section = ref('SettingsSection', `skill-${hash(x.skill.ref.id)}`);
      const description = textOf(x.skill.state?.description, 160);
      await provider.put(section, { state: { title: x.name, ...(description ? { description } : {}), icon: 'plugin' } });
      for (const decl of [switchOf(x.skill), ...x.params]) {
        const id = `s-${hash(target.id, x.skill.ref.id, decl.key)}`;
        index.set(id, { thread: target, skill: x.skill.ref, decl });
        want.add(id);
        await provider.put(ref('Setting', id), { state: stateOf(decl, x.values[decl.key]), links: { thread: target, definedBy: x.skill.ref, section } });
      }
    }
    for (const id of byThread.get(target.id) ?? []) {
      if (!want.has(id)) { index.delete(id); await provider.remove(ref('Setting', id)).catch(() => {}); }
    }
    byThread.set(target.id, want);
  }

  async function write(id, value) {
    const at = index.get(id);
    if (!at) return { status: 'refused', reason: 'unavailable', message: 'this chat\'s skills are being read again; try once more' };
    const key = storeKey(at.thread.id);
    const vk = valueKey(at.skill.id, at.decl.key);
    await ctx.storage.transaction((tx) => {   // synchronous, against a snapshot; commits atomically
      const cur = tx.get(key);
      const next = { ...(isObj(cur) ? cur : {}) };
      if (value === undefined || same(value, at.decl.default)) delete next[vk]; else next[vk] = value;
      if (Object.keys(next).length) tx.set(key, next); else tx.delete(key);
    });
    await provider.update(ref('Setting', id), { state: stateOf(at.decl, value === undefined ? at.decl.default : value) });
    return null;
  }

  provider = ctx.graph.provide({
    types: {
      Setting: {
        operations: {
          set: { effect: 'local', handler: async ({ ref: r, args: [v] }) => {
            const at = index.get(r.id);
            const value = at ? coerce(at.decl, v) : undefined;
            if (at && value === undefined) return { status: 'refused', reason: 'invalid', message: `not a valid ${at.decl.kind} for ${at.decl.title}` };
            return write(r.id, value);
          } },
          reset: { effect: 'local', handler: async ({ ref: r }) => write(r.id, undefined) },
        },
      },
      SettingsSection: {},
    },
    contributes: [{ type: 'Setting', via: 'thread' }],
    onObserve: (q) => (q?.relation === 'thread' && q.target ? refresh(q.target) : undefined),
  });

  // the agent's side: each message sent in a Codex chat carries the chat's skill choices while any differs from its default
  const send = ctx.graph.intercept('CodexThread', 'send', async (call, next) => {
    let said = null;
    try { said = contextOf(await choicesOf(call.ref)); } catch (e) { ctx.log.warn('the chat\'s skill choices could not be read', { message: String(e?.message ?? e) }); }
    if (!said) return next();
    const [content, options] = call.args;
    const o = isObj(options) ? options : {};
    const context = { ...(isObj(o.additionalContext) ? o.additionalContext : {}), [`mod:${ctx.mod.id}`]: { kind: 'application', value: said } };
    return next({ args: [content, { ...o, additionalContext: context }] });
  });

  // a skill added, changed or gone: the chats whose settings were read are put again
  const skills = ctx.graph.subscribe({ type: 'Skill' }, (m) => {
    if (m?.type !== 'delta') return;
    files.delete(m.event?.ref?.id);
    for (const id of byThread.keys()) refresh({ type: 'CodexThread', provider: 'codex', id }).catch(() => {});
  });

  return () => { skills.dispose(); send.dispose(); provider.dispose(); };
}

export default { host };
