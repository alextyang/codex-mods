// The app's saved thread drafts, custom prompt commands and composer operations (breadth step D5); a new chat's draft (mod-surfaces.md §3.6,
// E8.3): `new:app:new-conversation`, the app's own key, with its target's project (the app's selected project) and its operations through
// the main window's new chat. A side chat's (an ephemeral fork in the side panel) is written where its composer is shown, never through
// the app's messages (they reach another composer). Every draft here is a Codex chat's: a mod's chats are its own, in its own view
// (graph-integrity G2.2).
import { mkdir, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { refs, userInput } from '../map.mjs';
import { textOfDoc } from '../../../../../shared/draft-text.mjs';
import { flatTarget, nestTarget } from '../../../defaults.mjs';

export const realizes = {
  types: ['Draft', 'SlashCommand'],
  operations: { Draft: ['setContent', 'insert', 'attach', 'clear', 'send', 'setTarget'], Skill: ['use'], File: ['attachTo'], Project: ['newThread'], Agent: ['newThread'], Attachment: ['remove'] },
  supports: { SlashCommand: ['arguments', 'prompt'], Draft: ['target'] },
  events: { Draft: ['changed', 'sent', 'cleared'] },
  links: { Draft: ['thread', 'attachments', 'mentions'], SlashCommand: [], Attachment: ['draft'] },
};

/** The saved ProseMirror document as Content, retaining paragraph and hard-break newlines (shared/draft-text.mjs, as the page reads it). */
export function contentOfDoc(doc) {
  const text = textOfDoc(doc);
  return { parts: text ? [{ kind: 'text', text }] : [] };
}

const str = (v) => (typeof v === 'string' && v ? v : null);
const PATH_TARGETS = [['plugin://', refs.plugin], ['app://', refs.plugin]];   // an app's connector is a Plugin, as in a sent message (map.mjs)
/** What one chip of the composer names, when the graph has it: `{label, target}`, else null (a link, an MCP resource, a page or a browser tab). */
function chipOf(node) {
  const a = node.attrs && typeof node.attrs === 'object' ? node.attrs : {};
  const named = str(a.displayName) ?? str(a.name) ?? '';
  switch (node.type) {
    case 'atMention': {
      // a file by its path; a folder's path ends with '/' (the app's directory match)
      const path = str(a.fsPath) ?? str(a.path);
      if (!path) return null;
      const folder = /\/$/.test(path) || /\/$/.test(String(a.path ?? ''));
      const at = folder && path.length > 1 ? path.replace(/\/+$/, '') : path;
      return { label: str(a.label) ?? at, target: folder ? refs.folder(at) : refs.file(at) };
    }
    case 'skillMention': case 'browserSkillMention': return str(a.path) ? { label: named, target: refs.skill(a.path) } : null;
    case 'pluginMention': case 'appMention': {
      const path = str(a.path) ?? '';
      const [prefix, make] = PATH_TARGETS.find(([p]) => path.startsWith(p)) ?? [];
      return prefix && path.length > prefix.length ? { label: named, target: make(path.slice(prefix.length)) } : null;
    }
    case 'agentMention': return str(a.conversationId) ? { label: named, target: refs.thread(a.conversationId) } : null;
    default: return null;
  }
}
/** The chips of a saved document that name something the graph has, in the draft's order: `[{label, target}]`. */
export function mentionsOfDoc(doc) {
  const out = [];
  (function visit(node) {
    if (!node || typeof node !== 'object') return;
    const chip = chipOf(node);
    if (chip) out.push(chip);
    for (const child of Array.isArray(node.content) ? node.content : []) visit(child);
  })(doc);
  return out;
}

export const NEW_DRAFT = 'new:app:new-conversation';
export const PANEL_DRAFT = 'new:app:panel-new-conversation';   // the panel's "new thread" page (21477 shows no composer for it: its route redirects home)
const isNewDraft = (id) => typeof id === 'string' && id.startsWith('new:app:');
/** An item of a draft's tray as its composer shows it (H8d): `{id, kind, name, path?}`. */
export function attachmentData(draftId, it) {
  return { ref: { type: 'Attachment', provider: refs.agent().provider, id: `draft:${draftId}:${it.id}` },
    state: { name: String(it.name ?? 'attachment').slice(0, 300), kind: it.kind === 'image' ? 'image' : 'file' },
    links: { draft: refs.draft(draftId), ...(typeof it.path === 'string' && it.path.startsWith('/') ? { file: refs.file(it.path) } : {}) } };
}

/**
 * A chat's draft, or a new chat's (no thread yet; its target: the project it starts in, the Codex agent, and what its composer shows: where
 * it runs, its starting branch, its model, its effort and mode; E8.3h). `mentions`: the Mention instances of its chips, which it lists.
 */
export function draftData(threadId, doc, target, thread = refs.thread(threadId)) {
  const mentions = mentionsOfDoc(doc).map((m, i) => ({ ref: refs.draftMention(threadId, i), state: m, links: {} }));
  const d = draftOf(threadId, doc, target, thread);
  return { ...d, links: { ...d.links, mentions: mentions.map((m) => m.ref) }, mentions };
}
function draftOf(threadId, doc, target, thread) {
  if (isNewDraft(threadId)) {
    const project = typeof target?.project === 'string' ? target.project : null;
    const shown = target?.shown && typeof target.shown === 'object' ? target.shown : {};
    // where it runs: the project's own folder, a new worktree of it (made when sent), or the cloud (which environment the composer does not say)
    const environment = shown.environment === 'local' && project ? refs.localEnvironment(project) : shown.environment === 'worktree' ? 'worktree' : null;
    const settings = { ...(typeof shown.effort === 'string' ? { effort: shown.effort } : {}), ...(shown.mode === 'plan' || shown.mode === 'default' ? { mode: shown.mode } : {}),
      ...(shown.environment === 'cloud' ? { environment: 'cloud' } : {}) };
    return { ref: refs.draft(threadId), state: { content: contentOfDoc(doc), dictating: false,
      target: { ...(project ? { project: refs.project(project) } : {}), agent: refs.agent(),
        ...(environment ? { environment } : {}),
        ...(typeof shown.branch === 'string' && project && shown.environment === 'worktree' ? { branch: refs.branch(project, shown.branch) } : {}),
        ...(typeof shown.model === 'string' ? { model: refs.model(shown.model) } : {}), settings } },
    links: { thread: null, attachments: [], mentions: [] } };
  }
  return { ref: refs.draft(threadId), state: { content: contentOfDoc(doc), dictating: false }, links: { thread, attachments: [], mentions: [] } };
}

export function slashCommandData({ id, argumentHint, content }) {
  return { ref: refs.slashCommand(id), state: { title: `/prompts:${id}`, category: 'Prompts', enabled: true, name: `prompts:${id}`, custom: true,
    ...(argumentHint ? { arguments: argumentHint } : {}), ...(content ? { prompt: { parts: [{ kind: 'text', text: content }] } } : {}) }, links: {} };
}

export function types(feed) {
  return {
    Draft: { operations: {
      // each takes `{window}` last: the operation stays in that window (graph-layers.md §2)
      // and `{pane}`: that hosted chat's composer (layouts.md D8)
      setContent: { effect: 'external', handler: ({ ref, args }) => feed().inPane(args[1], () => feed().setContent(ref, args[0], args[1])) },
      insert: { effect: 'external', handler: ({ ref, args }) => feed().inPane(args[1], () => feed().insert(ref, args[0], args[1])) },
      attach: { effect: 'external', handler: ({ ref, args }) => feed().inPane(args[1], () => feed().attach(ref, args[0], args[1])) },
      clear: { effect: 'external', handler: ({ ref, args }) => feed().inPane(args[0], () => feed().clear(ref, args[0])) },
      // a change may not send it somewhere else than the user's chat (public-hooks.md §3.5)
      send: { effect: 'external', approval: ({ ref }) => feed().prompt('send', ref), widens: ({ original, args }) => (JSON.stringify(args[0] ?? null) !== JSON.stringify(original[0] ?? null) ? 'it sends it somewhere else' : null),
        handler: ({ ref, args }) => feed().inPane(args[0], () => feed().send(ref, args[0])) },
      setTarget: { effect: 'external', handler: ({ ref, args }) => feed().setTarget(ref, args[0], args[1]) },
    } },
    Skill: { operations: { use: { effect: 'external', handler: ({ instance, args }) => feed().inPane(null, () => feed().use(instance, args[0])) } } },
    // one of a draft's attachments taken out, as its composer's tray does (H8d)
    Attachment: { operations: { remove: { effect: 'external', handler: ({ ref }) => feed().removeAttachment(ref) } } },
    File: { operations: { attachTo: { effect: 'external', handler: ({ ref, args }) => feed().inPane(null, () => feed().attach(args[0], ref)) } } },
    Project: { operations: { newThread: { effect: 'external', approval: ({ ref, args }) => feed().prompt('project', ref, args[0]), handler: ({ ref, args }) => feed().newThread(ref, args[0]) } } },
    Agent: { operations: { newThread: { effect: 'external', approval: ({ ref, args }) => feed().prompt('agent', ref, args[0]), handler: ({ ref, args }) => feed().newThread(ref, args[0], true) } } },
    SlashCommand: { operations: { run: { effect: 'external', approval: ({ ref, args }) => feed().prompt('run', ref, args[0]), handler: ({ ref, args }) => feed().inPane(null, () => feed().run(ref, args[0])) } } },
  };
}

const TEXT_MAX = 512 * 1024, TEXT_NAME = /^[^/\\\0]{1,100}$/;   // a text attached: its size and its file's name
const IMAGE_MAX = 10 * 1024 * 1024, IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/;   // an image attached: its size, its data URL
const TEXT_KEEP_MS = 7 * 24 * 3600_000, TEXT_SWEEP_MS = 3600_000;
const SEND_ERROR = 'the app did not send it: no turn started (the chat must be open with its composer ready)';
const DETAIL = "Codex works on it with the chat's permissions, and it counts toward your usage.";
const textOf = (content) => (content?.parts ?? []).filter((p) => p.kind === 'text').map((p) => p.text).join('');
const refused = (reason, message) => ({ status: 'refused', reason, message });
/** The window an operation's `{window}` names (a Window of the windows provider): its id, null when none is named, NaN when it names none. */
const windowIdOf = (opts) => {
  const w = opts && typeof opts === 'object' ? opts.window : undefined;
  if (w === undefined || w === null) return null;
  return w && w.type === 'Window' && w.provider === 'codexmods.windows' && /^\d{1,12}$/.test(String(w.id)) ? Number(w.id) : NaN;
};
const NO_WINDOW = refused('invalid', 'window is a Window (an env\'s `window`)');
const NOT_THERE = refused('unavailable', 'that window does not show this draft\'s composer');

const NEW_MODEL = Object.freeze({ type: 'Setting', provider: 'codex', id: `${NEW_DRAFT}:model` });   // the new chat's model menu's subject
// the panel's new chat is written in its composer, live, while a window shows it (the app keeps no messages for it)
const PANEL_AWAY = Object.freeze({ status: 'refused', reason: 'unavailable', message: "the panel's new chat is written while its composer is shown" });
// a side chat is written and sent where its composer is shown: the app's messages and its submit command reach the window's active composer
const SIDE_AWAY = Object.freeze({ status: 'refused', reason: 'unavailable', message: "a side chat's draft is written while its composer is shown" });
const SIDE_SEND = Object.freeze({ status: 'refused', reason: 'unsupported', message: "a side chat's draft is sent from its composer" });
const MODEL_TRIES = 12, MODEL_EVERY_MS = 250;
const REACH_TRIES = 30, REACH_EVERY_MS = 100;   // how long a chat shown for an operation may take to mount its composer (3 s)   // how long a home page shown for a model choice may take to draw its menu (3 s)
const pause = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
const SETTLE_TRIES = 20, SETTLE_EVERY_MS = 100;   // how long the app may take to make a requested project the selected one (2 s)
// how long a new chat's send may take to be bound to its thread (a new worktree is made first), then uncertain
const BOUND_MS = 30_000, BOUND_EVERY_MS = 250;

export function createFeed(ctx) {
  const drafts = new Set(), commands = new Set(), turns = new Map(), pending = new Set();
  let heard = false, reading = null, readAt = -Infinity, timer = null, disposed = false;
  const isRef = (ref, type) => ref?.provider === 'codex' && ref.type === type && typeof ref.id === 'string' && ref.id.length > 0;
  /** The chat a draft key names: a resident Codex thread, else null. */
  function chatOf(id) {
    if (typeof id !== 'string' || !id || isNewDraft(id)) return null;
    return ctx.resident(refs.thread(id))?.ref ?? null;
  }
  /** Where the app's own messages may not write a draft (they act on the window's active composer): the panel's, a side chat's. */
  const away = (id) => (id === PANEL_DRAFT ? PANEL_AWAY : ctx.isEphemeral?.(id) ? SIDE_AWAY : null);
  function threadDraft(ref) {
    if (isRef(ref, 'Draft') && (ref.id === NEW_DRAFT || ref.id === PANEL_DRAFT)) return null;   // the main window's new chat; the panel's (live only)
    if (isRef(ref, 'Draft') && ref.id.startsWith('new:')) return refused('unsupported', "this new chat's draft is not reachable here");
    if (!isRef(ref, 'Draft') || !chatOf(ref.id)) return refused('unsupported', "a chat's draft is needed");
    return null;
  }
  /** What `attach` was given: `{path}`, `{skill}`, `{text, name}` (a text or an image's bytes), `{link}` (its text), or `{refusal}`. */
  function attachKind(what) {
    if (isRef(what, 'File') || isRef(what, 'Folder')) return { path: what.id };
    if (isRef(what, 'Skill')) return { skill: { name: what.id.split('/').filter(Boolean).at(-2) ?? what.id, path: what.id } };
    const plain = what && typeof what === 'object' && !Array.isArray(what) && what.type === undefined;
    if (plain && typeof what.text === 'string') {
      const name = what.name === undefined ? 'text.txt' : what.name;
      if (typeof name !== 'string' || !TEXT_NAME.test(name) || name.startsWith('.')) return { refusal: refused('invalid', 'name is a file name (no folders, not hidden, at most 100 characters)') };
      if (Buffer.byteLength(what.text, 'utf8') > TEXT_MAX) return { refusal: refused('invalid', `a text attached is at most ${TEXT_MAX / 1024} KB`) };
      return { text: what.text, name };
    }
    if (plain && typeof what.url === 'string') {
      let url;
      try { url = new URL(what.url); } catch { return { refusal: refused('invalid', 'url is an absolute URL') }; }
      if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return { refusal: refused('invalid', 'url is an http, https or mailto URL') };
      if (what.title !== undefined && typeof what.title !== 'string') return { refusal: refused('invalid', 'title is a string') };
      // the composer links a URL it is given as text (a markdown link would show its brackets): the title before it
      return { link: what.title ? `${what.title}: ${what.url}` : what.url };
    }
    if (plain && typeof what.image === 'string') {
      // an image of the mod's own, as a file of the framework's (as a text is): a PNG, JPEG, GIF or WebP data URL
      const m = IMAGE.exec(what.image);
      if (!m) return { refusal: refused('invalid', 'image is a data: URL of a PNG, JPEG, GIF or WebP image') };
      const bytes = Buffer.from(m[2], 'base64');
      if (!bytes.length || bytes.length > IMAGE_MAX) return { refusal: refused('invalid', `an image attached is at most ${IMAGE_MAX / 1024 / 1024} MB`) };
      const exts = m[1] === 'jpeg' ? ['jpg', 'jpeg'] : [m[1]];
      const name = what.name === undefined ? `image.${exts[0]}` : what.name;
      if (typeof name !== 'string' || !TEXT_NAME.test(name) || name.startsWith('.') || !exts.some((e) => name.toLowerCase().endsWith(`.${e}`))) return { refusal: refused('invalid', `name is a file name ending in .${exts[0]} (no folders, not hidden)`) };
      return { text: bytes, name, image: what.image };
    }
    return { refusal: refused('invalid', 'attach takes a File or Folder, a Skill, {text, name?}, {image, name?} or {url, title?}') };
  }
  /** A text (or an image's bytes) attached to a draft, as a file of the framework's own (its own folder: two of one name never meet); older ones go. */
  async function writeText(name, text) {
    await sweepTexts();
    const dir = join(ctx.filesDir, randomUUID());
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, name);
    await writeFile(path, text, { mode: 0o600, flag: 'wx' });
    return path;
  }
  // a text attached stays while the chat it was sent in may read it again: a week, swept at most once an hour
  let sweptAt = -Infinity;
  async function sweepTexts() {
    if (ctx.now() - sweptAt < TEXT_SWEEP_MS) return;
    sweptAt = ctx.now();
    let names;
    try { names = await readdir(ctx.filesDir); } catch { return; }
    for (const n of names) {
      try { if (Date.now() - (await stat(join(ctx.filesDir, n))).mtimeMs > TEXT_KEEP_MS) await rm(join(ctx.filesDir, n), { recursive: true, force: true }); } catch { /* the next sweep */ }
    }
  }
  let newChat = { project: null, clientId: null, cloud: null };   // the new chat's target, its own client id and the app's cloud environment, as framework-main reported them
  let shown = null;   // and as a window's composer shows it (E8.3h): the latest a window told
  let newDoc = null;   // the new chat's text as last reported (its target is put again with it)
  const named = new Map();   // draft id -> what its Mentions say (their states), to tell a change of its chips from the same text
  // a draft's attachments as the windows' composers show them (H8d: the composer's tray), by window, then by Draft: the latest window's
  const trays = new Map();   // window id -> {draft id -> [{id, kind, name, path?}]}, in the order the windows last reported (the latest last)
  const attachmentRef = (draftId, itemId) => attachmentData(draftId, { id: itemId }).ref;
  /** A draft's tray as the window that reported it last shows it, and that window. */
  const shownAttachments = (draftId) => { let at = { items: [], windowId: null }; for (const [w, t] of trays) if (Array.isArray(t[draftId])) at = { items: t[draftId], windowId: w }; return at; };
  const keptAttachments = new Map();   // draft id -> the Attachment ids put for it
  const attachmentKeys = new Map();    // an Attachment id -> {draftId, itemId, windowId}: which tray entry it is, in which window's composer
  /** Its Attachment instances as its composers show them: put, and the ones gone removed; the Draft lists them. */
  function applyAttachments(draftId) {
    const { items, windowId } = shownAttachments(draftId);
    const now = new Set();
    for (const it of items) {
      const ref = attachmentRef(draftId, it.id);
      now.add(ref.id);
      attachmentKeys.set(ref.id, { draftId, itemId: it.id, windowId });
      const data = attachmentData(draftId, it);
      ctx.safe('attachment', () => ctx.handle.put(ref, { state: data.state, links: data.links }));
    }
    for (const id of keptAttachments.get(draftId) ?? []) if (!now.has(id)) { attachmentKeys.delete(id); ctx.safe('attachment removal', () => ctx.handle.remove({ type: 'Attachment', provider: refs.agent().provider, id })); }
    if (now.size) keptAttachments.set(draftId, now); else keptAttachments.delete(draftId);
    const d = ctx.resident(refs.draft(draftId));
    const list = [...now].map((id) => ({ type: 'Attachment', provider: refs.agent().provider, id }));
    if (d && JSON.stringify(d.links.attachments ?? []) !== JSON.stringify(list)) ctx.safe('draft attachments', () => ctx.handle.update(d.ref, { links: { attachments: list } }));
  }
  const traySub = ctx.bus?.subscribe?.('window/attachments', (m) => {
    if (disposed || !m || !Number.isSafeInteger(m.windowId)) return;
    const before = new Set(Object.keys(trays.get(m.windowId) ?? {}));
    const drafts = m.drafts && typeof m.drafts === 'object' ? m.drafts : {};
    // the latest report last (a window's report moves it there); a window that shows none (its page gone) is forgotten
    trays.delete(m.windowId);
    if (Object.keys(drafts).length) trays.set(m.windowId, drafts);
    for (const id of new Set([...before, ...Object.keys(drafts)])) applyAttachments(id);
  }) ?? null;

  function applyDraft(threadId, doc, sync) {
    if (threadId === NEW_DRAFT) newDoc = doc;
    const d = draftData(threadId, doc, threadId === NEW_DRAFT ? { ...newChat, shown } : isNewDraft(threadId) ? {} : undefined, chatOf(threadId) ?? refs.thread(threadId));
    d.links.attachments = [...(keptAttachments.get(threadId) ?? [])].map((id) => ({ type: 'Attachment', provider: refs.agent().provider, id }));
    const before = textOf(ctx.resident(d.ref)?.state.content), after = textOf(d.state.content);
    const was = named.get(threadId) ?? [], now = d.mentions.map((m) => JSON.stringify(m.state));
    for (const m of d.mentions) ctx.handle.put(m.ref, { state: m.state, links: m.links });
    ctx.handle.put(d.ref, { state: d.state, links: d.links });
    for (let i = now.length; i < was.length; i++) ctx.handle.remove(refs.draftMention(threadId, i));
    named.set(threadId, now);
    drafts.add(threadId);
    const changed = before !== after || was.join('\n') !== now.join('\n');
    const event = after ? 'changed' : turns.has(threadId) && ctx.now() - turns.get(threadId) <= 3000 ? 'sent' : 'cleared';
    if (!sync && changed) ctx.emitEvent(d.ref, event);
    // a new chat begins when its draft is sent or cleared (public-hooks.md §3.8): its defaults apply again
    if (threadId === NEW_DRAFT && !sync && changed && event !== 'changed') { epoch++; chosen = new Set(); ours = {}; scheduleDefaults(); }
  }
  // ---- the mods' defaults for a new chat (public-hooks.md §3.8): applied while a window shows it, when it begins (its draft created,
  // sent or cleared), when that window starts showing it and when its project changes; to the fields the user has not chosen in this
  // epoch (each field's provenance: the user's, a default's, or the app's, which a default replaces); the first mod in order that gives a
  // field gives it; the text only into an empty draft
  let epoch = 0, defaultsTimer = null, applying = false;
  let chosen = new Set();   // the target fields (flat: `model`, `settings.effort`) the user chose in this epoch
  let ours = {};            // what the defaults last put, by field: seen again in a window's report, it is theirs, not the user's
  const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  // a field's value: a ref is the same thing by its provider and id (a default may name a model by its concept, the composer by its type)
  const sameField = (a, b) => (a && b && typeof a === 'object' && typeof b === 'object' && typeof a.id === 'string' ? a.provider === b.provider && a.id === b.id : sameValue(a, b));
  /** A window's report of the new chat's target, as the Draft's target fields (flat). */
  const flatShown = (raw) => flatTarget(draftOf(NEW_DRAFT, null, { project: typeof raw?.project === 'string' ? raw.project : newChat.project, shown: raw ?? {} }).state.target);
  /**
   * What changed between two reports of the new chat's target: a field the defaults did not put is the user's choice in this epoch, unless
   * the project changed with it (the app puts the other project's own values then; a default may replace those).
   */
  function noteChoices(before, after) {
    const a = flatShown(before), b = flatShown(after);
    const otherProject = !sameField(a.project, b.project);
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (sameField(a[k], b[k])) continue;
      if (k in ours && sameField(ours[k], b[k])) continue;
      if (otherProject && k !== 'project') continue;
      chosen.add(k);
    }
  }
  function scheduleDefaults() {
    if (defaultsTimer || disposed || typeof ctx.graph?.defaultsFor !== 'function') return;
    defaultsTimer = setTimeout(() => { defaultsTimer = null; void applyDefaults(); }, 300);
    defaultsTimer.unref?.();
  }
  async function applyDefaults() {
    if (disposed || applying || !shown) return;
    const ref = refs.draft(NEW_DRAFT);
    const inst = ctx.resident(ref);
    if (!inst) return;
    const list = ctx.graph.defaultsFor('Draft', inst);
    if (!list.length) return;
    applying = true;
    try {
      const at = epoch;
      const now = flatTarget(inst.state.target ?? {});
      const want = {};
      for (const d of list) for (const [k, v] of Object.entries(flatTarget(d.target))) if (!(k in want)) want[k] = v;
      // a new chat's settings here are Codex's effort and mode
      const set = {};
      for (const [k, v] of Object.entries(want)) {
        const setting = k.startsWith('settings.') ? k.slice('settings.'.length) : null;
        if (setting !== null && setting !== 'effort' && setting !== 'mode') continue;   // none of Codex's
        if (chosen.has(k)) continue;   // the user chose it in this epoch: theirs
        if (!sameField(now[k], v)) set[k] = v;
      }
      const windowId = [...shownBy.keys()].at(-1);
      const win = Number.isSafeInteger(windowId) ? { window: { type: 'Window', provider: 'codexmods.windows', id: String(windowId) } } : undefined;
      if (Object.keys(set).length) {
        // theirs from now: a window's report of one of these while the rest are still being set is the defaults', not the user's choice
        const before = ours;
        ours = { ...ours, ...set };
        const r = await setTarget(ref, nestTarget(set), win);
        if (r) {
          ctx.log.info('composer: a new chat\'s defaults were not applied', { status: r.status, message: r.message });
          if (epoch === at) ours = before;
        }
      }
      const content = list.find((d) => d.content)?.content;
      if (content && epoch === at && !textOf(ctx.resident(ref)?.state.content) && Number.isSafeInteger(windowId)) {
        const text = input(content).text;
        if (text) await composerAct(ref, 'setTextIf', ['', text], windowId);
      }
    } catch (e) { ctx.log.warn('composer: a new chat\'s defaults failed', { message: String(e?.message ?? e) }); }
    finally { applying = false; }
  }
  /** A draft whose chat is gone goes, with its mentions. */
  function dropDraft(threadId) {
    for (let i = 0; i < (named.get(threadId)?.length ?? 0); i++) ctx.handle.remove(refs.draftMention(threadId, i));
    named.delete(threadId);
    for (const id of keptAttachments.get(threadId) ?? []) { attachmentKeys.delete(id); ctx.safe('attachment removal', () => ctx.handle.remove({ type: 'Attachment', provider: refs.agent().provider, id })); }
    keptAttachments.delete(threadId);
    ctx.handle.remove(refs.draft(threadId));
    drafts.delete(threadId);
  }
  // The drafts the app saved, as framework-main last reported them: a chat's Draft is put with its saved text whenever it is (its first
  // report comes as the app's window is held, before the threads are read)
  let saved = new Map();   // threadId -> doc
  const THREAD_READS = new Set(['thread/list', 'thread/read', 'thread/start', 'thread/resume', 'thread/fork']);
  // Every chat has a draft (`Thread.draft`, derived from its `thread`): an empty one until the app saves one, so a mod's operations and the
  // composer's presentation find it.
  function everyChat() {
    for (const t of ctx.graph.list('CodexThread')) {
      if (!t.gone && !drafts.has(t.ref.id) && chatOf(t.ref.id)) applyDraft(t.ref.id, saved.get(t.ref.id) ?? null, true);
    }
  }
  // the new chat's target as the windows' composers show it (E8.3h): the latest window that shows one; a window that shows none no longer counts
  const shownBy = new Map();   // window id -> target, the latest told last
  const told = ctx.bus?.subscribe?.('window/newChat', (d) => {
    if (disposed || !d || !Number.isSafeInteger(d.windowId)) return;
    shownBy.delete(d.windowId);
    if (d.target && typeof d.target === 'object') shownBy.set(d.windowId, d.target);
    const next = shownBy.size ? [...shownBy.values()].at(-1) : null;
    if (JSON.stringify(next) === JSON.stringify(shown)) return;
    const startsShowing = !shown && next, otherProject = shown && next && !sameValue(shown.project, next.project);
    if (shown && next) noteChoices(shown, next);
    shown = next;
    if (drafts.has(NEW_DRAFT)) applyDraft(NEW_DRAFT, newDoc, true);
    // a window starts showing the new chat, or it shows another project: its defaults apply (the user's choices kept)
    if (startsShowing || otherProject) scheduleDefaults();
  }) ?? null;
  // defaults declared or gone while a window shows the new chat: they apply now
  const defaultsSub = ctx.graph?.onDefaults?.(() => scheduleDefaults()) ?? null;
  const reports = ctx.onMainReport((report) => {
    if (disposed || !Array.isArray(report?.drafts)) return;
    const sync = !heard, present = new Set();
    heard = true;
    saved = new Map(report.drafts.filter((e) => typeof e?.threadId === 'string' && !e.threadId.startsWith('new:')).map((e) => [e.threadId, e.doc ?? null]));
    newChat = { project: typeof report.newChat?.project === 'string' ? report.newChat.project : null,
      clientId: typeof report.newChat?.clientId === 'string' ? report.newChat.clientId : null,
      cloud: report.newChat?.cloud && typeof report.newChat.cloud === 'object' ? { id: String(report.newChat.cloud.id ?? ''), label: String(report.newChat.cloud.label ?? '') } : null };
    // the new chat's draft is always there (empty until the app saves one)
    const fresh = report.drafts.find((e) => e?.threadId === NEW_DRAFT);
    applyDraft(NEW_DRAFT, fresh?.doc ?? null, sync && !drafts.has(NEW_DRAFT));
    // so is the panel's (and the hotkey window's) new chat (E8 third review: written live while its composer is shown)
    const panel = report.drafts.find((e) => e?.threadId === PANEL_DRAFT);
    applyDraft(PANEL_DRAFT, panel?.doc ?? null, sync && !drafts.has(PANEL_DRAFT));
    for (const entry of report.drafts) {
      if (typeof entry?.threadId !== 'string' || entry.threadId.startsWith('new:')) continue;
      if (!chatOf(entry.threadId)) continue;   // kept in `saved` until its chat comes
      present.add(entry.threadId);
      applyDraft(entry.threadId, entry.doc, sync);
    }
    for (const id of drafts) {
      if (isNewDraft(id)) continue;
      if (!chatOf(id)) { dropDraft(id); turns.delete(id); }
      else if (!present.has(id)) applyDraft(id, null, sync);
    }
  });

  async function readPrompts() {
    if (disposed) return;
    if (reading) return reading;
    reading = (async () => {
      try {
        const r = await ctx.mainOp('prompts', {});
        if (!r.ok) throw new Error(r.error);
        if (disposed || !Array.isArray(r.result?.prompts)) return;
        const present = new Set();
        for (const prompt of r.result.prompts) {
          const d = slashCommandData(prompt);
          ctx.handle.put(d.ref, { state: d.state, links: d.links });
          present.add(d.ref.id);
        }
        for (const id of commands) if (!present.has(id)) ctx.handle.remove({ type: 'SlashCommand', provider: 'codex', id });
        commands.clear();
        for (const id of present) commands.add(id);
      } catch (e) { ctx.log.warn('composer: prompts could not be read', { message: String(e?.message ?? e) }); }
    })().finally(() => { reading = null; readAt = ctx.now(); });
    return reading;
  }
  /**
   * A page operation on the composer that shows this Draft now (its live controller): true when it was done there, false when no composer
   * shows it or the page said it cannot (nothing was changed: the caller may use the app's own messages). An uncertain end (the page did
   * not answer in time) is thrown: the edit may have been made, so it is never made again another way.
   */
  async function live(ref, op, args, windowId = null, seen = null, keepRefusal = false) {
    const out = await ctx.pageAct?.('Composer', ref, op, args, windowId);
    if (!out) return false;
    // two composers of it in that window (one kept out of sight): which one is not known, so nothing else is tried there
    if (out.status === 'refused' && /two of these|which one is not known/.test(String(out.message ?? ''))) throw Object.assign(new Error(out.message), { refusal: out });
    // `keepRefusal`: the composer's own reason (not "cannot do it here", which leaves the caller its other way) is the answer
    if (out.status === 'refused') return keepRefusal && !new RegExp(`cannot ${op} (now|here)$`).test(String(out.message ?? '')) ? out : false;
    if (out.status === 'done') { if (typeof seen === 'function') seen(out.windowId); return true; }
    throw new Error(`the composer did not say whether it did this: ${out.error?.message ?? 'no answer'}`);
  }
  /**
   * The one window a Draft operation acts in (graph-layers.md §2): the caller's `{window}` (`named`); else the window that shows the
   * Draft (the one in front among several, else refused: `refusal`); else the window in front (`shows` false: the app's own messages show
   * the Draft there). `windowId` null when no window has a page (the app's own messages choose).
   */
  const MANY_PANES = () => refused('unavailable', 'this chat is shown in more than one pane here: say which, with {pane}');
  async function placeOf(ref, opts) {
    const named = windowIdOf(opts);
    if (Number.isNaN(named)) return { refusal: NO_WINDOW };
    const paneNamed = opts && typeof opts === 'object' && typeof opts.pane === 'string' ? opts.pane : null;
    let at;
    // a window named: whether it shows this Draft (another draft shown there is never this one's: built review, round 2)
    if (named !== null) at = { windowId: named, named: true, shows: ctx.showsIn?.(named, 'Composer', ref) === true };
    else {
      const chosen = await ctx.chooseWindow?.('Composer', ref);
      if (chosen?.refused) return { refusal: chosen.refused };
      const windowId = Number.isSafeInteger(chosen?.windowId) ? chosen.windowId : null;
      // windows are known and none can be told (pages reloading): refused, never the app's first window by default
      if (windowId === null && typeof ctx.showsIn === 'function') return { refusal: refused('unavailable', 'no window to act in now') };
      at = { windowId, named: false, shows: chosen?.shows === true };
    }
    // a chat shown in more than one pane here (layouts.md D8): which composer is never guessed; a pane named that has closed is gone, never the app's own messages to another
    const panes = at.windowId !== null ? ctx.panesOf?.(at.windowId, 'Composer', ref) ?? [] : [];
    if (paneNamed !== null && !panes.includes(paneNamed)) return { refusal: refused('gone', 'that pane has closed') };
    if (paneNamed === null && panes.length > 1) return { refusal: MANY_PANES() };
    // what it acts on from here on is that composer, whatever opens or takes the focus meanwhile (layouts.md D8)
    if (panes.length) ctx.capturePane?.(at.windowId, paneNamed ?? panes[0]);
    return at;
  }
  const inWin = (p) => (p.windowId !== null ? { windowId: p.windowId } : {});
  /** The composer of `ref` in that window holds `text` now (its live editor read): null, or the refusal. */
  async function sameText(ref, text, windowId) {
    const out = await composerAct(ref, 'textIs', [text], windowId);
    if (out?.status === 'done') return null;
    return out?.status === 'refused' ? refused('unavailable', `the draft ${/changed/.test(out.message ?? '') ? 'changed: it is not sent (the edit is kept)' : 'could not be read where it is shown'}`)
      : refused('unavailable', 'the draft is not shown where it was written');
  }
  /**
   * The window whose composer of this chat's Draft an operation acts in, that composer itself (H5x review 1: the app's messages and its
   * submit command reach the window's active composer, which may be another, a side chat's): the place's window when it shows it; else the
   * chat shown there by framework-main, once its composer is mounted. `{windowId}`, or `{refusal}`; `{windowId, unverified: true}` where the
   * Host cannot tell what a window shows (no pages report: the app's messages, as framework-main shows the chat), and for a new chat's.
   */
  async function reach(ref, p) {
    if (p.shows && p.windowId !== null) return { windowId: p.windowId };
    if (p.named) return { refusal: NOT_THERE };
    const a = away(ref.id);
    if (a) return { refusal: a };
    if (typeof ctx.showsIn !== 'function' || isNewDraft(ref.id)) return { windowId: p.windowId, unverified: true };
    const r = await ctx.mainOp('show', { threadId: ref.id, ...inWin(p) });
    if (!r.ok) { if (r.refused) return { refusal: refused('unavailable', r.error) }; throw new Error(r.error); }
    const windowId = Number.isSafeInteger(r.result?.windowId) ? r.result.windowId : p.windowId;
    for (let i = 0; i < REACH_TRIES && !disposed && windowId !== null; i++) {
      if (ctx.showsIn(windowId, 'Composer', ref)) {
        // shown there now: what it acts on from here on is that composer, as placeOf settles on one already shown
        const panes = ctx.panesOf?.(windowId, 'Composer', ref) ?? [];
        if (panes.length > 1 && ctx.heldPane?.() === undefined) return { refusal: MANY_PANES() };
        if (panes.length) ctx.capturePane?.(windowId, ctx.heldPane?.() ?? panes[0]);
        return { windowId };
      }
      await pause(REACH_EVERY_MS);
    }
    return { refusal: refused('unavailable', "the chat's composer was not shown") };
  }
  /** The app's own messages to the composer reached (a skill's chip, a file), with its editor focused first so they reach it, not another. */
  async function viaMessages(ref, at, send) {
    // they go to the window's active composer: an operation kept to a pane cannot be sure of it, unless the window's own is the only one of this chat there
    const held = ctx.heldPane?.();
    if (held !== undefined && (held !== 'route' || (at.windowId !== null && (ctx.panesOf?.(at.windowId, 'Composer', ref) ?? []).length > 1))) return refused('unavailable', "that pane's composer cannot take this now");
    if (at.unverified) return send(at.windowId !== null ? { windowId: at.windowId } : {});
    const f = await composerAct(ref, 'focus', [], at.windowId);
    if (f?.status !== 'done') return refused('unavailable', "the chat's composer could not take it now");
    return send({ windowId: at.windowId, shown: true });
  }
  /** What `attach` does once it has its place: a link or a skill in the text, an image as a paste, else a file. */
  async function attachIn(ref, p, kind) {
    if (kind.link) return edit(ref, p, [['insert', [kind.link]]], (w) => main('insert', { threadId: ref.id, text: kind.link, skills: [], ...w }));
    if (kind.skill) return edit(ref, p, [['insertSkill', [kind.skill]]], (w) => main('insert', { threadId: ref.id, text: '', skills: [kind.skill], ...w }));
    // an image, where a composer shows the Draft: the app's own paste there (its tray, its upload); else a file of the framework's, as a text
    if (kind.image && p.shows && p.windowId !== null) {
      const pasted = await live(ref, 'attachImage', [kind.image, kind.name], p.windowId, null, true);
      if (pasted === true) return null;
      // the composer that shows it said why not (a queued message edited there, a model that takes no images): not attached another way
      if (pasted) return refused('unavailable', pasted.message ?? 'its composer takes no image now');
    }
    if (ref.id === PANEL_DRAFT) return refused('unsupported', "the panel's new chat takes files in its composer");
    // its own composer, reached (H5x review 1): an image pasted there once it shows, else a file of the framework's by the app's message
    const at = await reach(ref, p);
    if (at.refusal) return at.refusal;
    if (kind.image && !at.unverified && !(p.shows && at.windowId === p.windowId)) {
      const pasted = await live(ref, 'attachImage', [kind.image, kind.name], at.windowId, null, true);
      if (pasted === true) return null;
      if (pasted) return refused('unavailable', pasted.message ?? 'its composer takes no image now');
    }
    let path = kind.path;
    if (kind.text !== undefined) {
      if (!ctx.filesDir) return refused('unavailable', "the framework has no folder for a draft's texts");
      path = await writeText(kind.name, kind.text);
    }
    // a text it wrote for this goes with a refusal: what a mod tried to attach is not kept
    const forget = async () => { if (kind.text !== undefined) await rm(dirname(path), { recursive: true, force: true }).catch(() => {}); };
    try {
      // told by its very composer where it can be, so it reaches no other
      if (!at.unverified) {
        const told = await live(ref, 'attachFile', [{ label: basename(path), path, fsPath: path }], at.windowId, null, true);
        if (told === true) return null;
        if (told) { await forget(); return refused('unavailable', told.message ?? 'its composer takes no file now'); }
      }
      const out = await viaMessages(ref, at, (w) => main('attach', { threadId: ref.id, path, ...w }));
      if (out?.status === 'refused') await forget();
      return out;
    } catch (e) {
      // its answer not known (no reply, the page gone): the composer may hold it, so it stays
      if (e.refusal) await forget();
      throw e;
    }
  }
  /**
   * An edit, its steps (`[[op, args], …]`: setText, insert, insertSkill, clear) done live and in order in the Draft's own composer: in the
   * place, or in its composer once reached; else (a composer that takes none of them, or none the Host can tell) the app's own messages to
   * it. Done, or the refusal.
   */
  async function edit(ref, p, steps, fallback) {
    const runIn = async (windowId) => {
      for (let i = 0; i < steps.length; i++) {
        if (await live(ref, steps[i][0], steps[i][1], windowId)) continue;
        if (i === 0) return false;
        throw Object.assign(new Error('the composer stopped taking the edit part way'), { refusal: refused('unavailable', 'its composer took part of the edit, then no more') });
      }
      return steps.length > 0;
    };
    let at;
    try {
      if (await runIn(p.windowId)) return null;
      at = await reach(ref, p);
      if (at.refusal) return at.refusal;
      // shown there now (framework-main showed the chat): live in it
      if (!at.unverified && !(p.shows && at.windowId === p.windowId) && await runIn(at.windowId)) return null;
    } catch (e) { if (e.refusal) return e.refusal; throw e; }
    return viaMessages(ref, at, fallback);
  }
  /** A content's edit as live steps: its text set (or inserted), then each skill's chip. */
  const stepsOf = (set, args) => [...(set ? [['setText', [args.text]]] : args.text ? [['insert', [args.text]]] : []), ...args.skills.map((s) => ['insertSkill', [s]])];
  /**
   * A Draft's content written only while it holds nothing (no text, no chip; its attachments are not read): in the composer that shows it,
   * read and written in one step (an edit of the user's is never written over); else, when the draft the app saved is empty, put in with
   * the app's own messages as an insert (never a clear). Refused when it holds something.
   */
  async function writeIfEmpty(ref, p, args) {
    if (!args.text && !args.skills.length) return null;
    const NOT_EMPTY = refused('unavailable', 'the draft is not empty: it is not written over');
    if (!args.skills.length) {
      const out = await composerAct(ref, 'setTextIf', ['', args.text], p.windowId);
      if (out?.status === 'done') return null;
      if (out?.status === 'refused' && /changed/.test(out.message ?? '')) return NOT_EMPTY;
      if (out?.status === 'refused' && /two of these|which one is not known/.test(out.message ?? '')) return refused('unavailable', out.message);
    }
    if (p.named) return NOT_THERE;
    const a = away(ref.id);
    if (a) return a;
    if (textOf(ctx.resident(ref)?.state.content)) return NOT_EMPTY;
    const at = await reach(ref, p);
    if (at.refusal) return at.refusal;
    // shown there now: read and written in one step in it
    if (!at.unverified && !args.skills.length) {
      const out = await composerAct(ref, 'setTextIf', ['', args.text], at.windowId);
      if (out?.status === 'done') return null;
      if (out?.status === 'refused') return /changed/.test(out.message ?? '') ? NOT_EMPTY : refused('unavailable', out.message ?? 'its composer could not take it');
    }
    return viaMessages(ref, at, (w) => main('insert', { threadId: ref.id, ...args, ...w }));
  }
  /** A page operation on the composer of a Draft: null when no window shows it, else its answer (done, or its refusal). */
  async function composerAct(ref, op, args, windowId = null) {
    const out = await ctx.pageAct?.('Composer', ref, op, args, windowId);
    if (!out) return null;
    if (out.status === 'done' || out.status === 'refused') return out;
    throw new Error(`the composer did not say whether it did this: ${out.error?.message ?? 'no answer'}`);
  }
  /** The new chat's model menu chooses (E8.3c): null when no window shows it, else its answer (done, or its refusal). */
  async function chooseModel(slug, effort, windowId = null) {
    const out = await ctx.pageAct?.('ComposerPicker', NEW_MODEL, 'choose', [slug, effort], windowId);
    if (!out) return null;
    if (out.status === 'done' || out.status === 'refused') return out;
    throw new Error(`the model menu did not say whether it chose: ${out.error?.message ?? 'no answer'}`);
  }
  /** The new chat shown in a window (its route seeds applied there): `{windowId}` (null when main does not say), or `{refusal}`. */
  async function showNew(args) {
    const r = await ctx.mainOp('new-chat', args);
    if (r.ok) return { windowId: Number.isSafeInteger(r.result?.windowId) ? r.result.windowId : null };
    if (r.refused) return { refusal: refused('unavailable', r.error) };
    throw new Error(r.error);
  }
  async function main(op, args) {
    const r = await ctx.mainOp(op, args);
    if (r.ok) return null;
    if (r.refused) return refused('unavailable', r.error);
    throw new Error(r.error);
  }
  function input(content) {
    const inputs = userInput(content);
    return { text: inputs.find((p) => p.type === 'text')?.text ?? '', skills: inputs.filter((p) => p.type === 'skill').map(({ name, path }) => ({ name, path })) };
  }
  /** Is a started thread the chat this send starts: a chat of the user's own (no sub-agent's, not ephemeral) whose first message, when
   *  the app already says it, is the draft's text? Another chat started meanwhile (an automation, a sub-agent) is not. */
  const norm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  function startedFor(thread, expect) {
    if (!thread || thread.parentThreadId || thread.ephemeral === true) return false;
    const pv = norm(thread.preview), want = norm(expect?.text);
    // the fallback where the app says no client id (an older build): only a chat whose first message is the text sent is this send's;
    // one that does not say its first message yet is a candidate only (the outcome is then uncertain, never done: built review)
    if (!pv) return want ? 'maybe' : true;
    return !want || pv.startsWith(want.slice(0, 40)) || want.startsWith(pv.slice(0, 40));
  }
  /** A send (`dispatch()`: null when dispatched, else its refusal) and the turn (or new chat) it started, by `method`'s notification. */
  async function submit(dispatch, threadId, ms, expect, method = threadId ? 'turn/started' : 'thread/started') {
    // Listen before dispatch: the app can notify before framework-main answers. Old turns never satisfy this wait.
    let resolve, timeout;
    const promise = new Promise((r) => { resolve = r; });
    const wait = { method, threadId, expect, resolve };
    pending.add(wait);
    try {
      const r = await dispatch();
      if (r) return r;
      const result = await Promise.race([promise, new Promise((r) => { timeout = setTimeout(() => r(null), ms); timeout.unref?.(); })]);
      if (result) return result;
      // a chat started that may be this send's, without a first message to tell: uncertain, never another send's thread as done
      if (wait.candidate) return { status: 'uncertain', operation: 'Draft.send' };
      throw new Error(SEND_ERROR);
    } finally { clearTimeout(timeout); pending.delete(wait); }
  }
  /**
   * A new chat's send: the Thread it made, by the app's own binding of the new chat's client id to that thread (exact: never another chat
   * started meanwhile); uncertain when it is not bound in time (it may still be made). Without a client id (an older build), by the
   * started thread that looks like it.
   */
  async function sendNew(op, args, clientId, expect) {
    if (!clientId) return submit(() => main(op, args), null, 10_000, expect);
    // a client id already bound is a send that happened (the user's, just now): the new chat's id for this send is not known yet
    const before = await ctx.mainOp('bound', { clientId });
    if (before.ok && typeof before.result?.threadId === 'string') return refused('unavailable', 'the new chat was just sent: try again once it shows its next draft');
    const r = await main(op, args);
    if (r) return r;
    for (let waited = 0; waited < BOUND_MS && !disposed; waited += BOUND_EVERY_MS) {
      await pause(BOUND_EVERY_MS);
      const b = await ctx.mainOp('bound', { clientId });
      if (b.ok && typeof b.result?.threadId === 'string') return refs.thread(b.result.threadId);
    }
    return { status: 'uncertain', operation: 'Draft.send' };
  }
  function seed(draft, required) {
    if (draft === undefined && !required) return { text: '' };
    const state = isRef(draft, 'Draft') && ctx.resident(draft)?.state;
    if (!state?.content) return refused('invalid', 'a draft with content is needed');
    const text = input(state.content).text;
    if (required && !text) return refused('invalid', 'a draft with text is needed');
    const project = state.target?.project;
    if (required && project !== undefined && !isRef(project, 'LocalProject')) return refused('unsupported', 'a local Codex project is needed');
    return { text, ...(required && project ? { projectId: project.id } : {}) };
  }
  function runCheck(args) {
    if (!isRef(args?.thread, 'CodexThread') || !ctx.resident(args.thread) || (args.arguments !== undefined && typeof args.arguments !== 'string')) return refused('invalid', 'a Codex thread and optional arguments are needed');
    if (textOf(ctx.resident(refs.draft(args.thread.id))?.state.content)) return refused('unavailable', "the chat's composer has text: Codex would send it too");
    return null;
  }

  /** A new chat from a Draft (E8.3a): its text and project, shown and sent by the app's own new chat. */
  async function fromDraft(ref, draft, agent) {
    if (draft !== undefined && !ctx.serverUp()) return ctx.DOWN;
    if (agent && (ref.type !== 'CodexAgent' || ref.id !== 'codex')) return refused('unsupported', 'the Codex agent is needed');
    const s = seed(draft, agent);
    if (s.status) return s;
    const projectId = agent ? s.projectId : ref.id;
    const r = await main('new-chat', { ...(projectId ? { projectId } : {}), ...(s.text ? { text: s.text } : {}) });
    if (r || !s.text) return r;
    return sendNew('submit-new', {}, newChat.clientId, { text: s.text });
  }
  const SPEC = new Set(['prompt', 'attachments', 'project', 'environment', 'branch', 'model', 'effort', 'mode', 'access', 'send', 'open', 'replace', 'window']);
  let preparing = Promise.resolve();   // the new chat's preparations, one at a time
  /**
   * A chat from a spec (graph-layers.md §3.2), in one window chosen before its first step: its target, its text, its files; sent when
   * asked. The user's draft is never written over (refused unless `replace`) and never rolled back; a send is refused when the Draft no
   * longer holds what this operation wrote (the user typed meanwhile). Answers the Thread its send made (or uncertain), unsent the Draft.
   */
  async function prepare(ref, spec, agent) {
    if (!ctx.serverUp()) return ctx.DOWN;
    if (agent && (ref.type !== 'CodexAgent' || ref.id !== 'codex')) return refused('unsupported', 'the Codex agent is needed');
    const unknown = Object.keys(spec).filter((k) => !SPEC.has(k));
    if (unknown.length) return refused('invalid', `a chat's spec has no ${unknown.join(', ')}`);
    if (spec.open === false) return refused('unsupported', "a new chat is prepared in a window's composer: it is shown (open: true)");
    if (!agent && spec.project !== undefined) return refused('invalid', 'a project\'s new chat is in that project');
    const text = typeof spec.prompt === 'string' ? spec.prompt : spec.prompt === undefined ? '' : textOf(spec.prompt);
    if (spec.prompt !== undefined && typeof spec.prompt !== 'string' && !Array.isArray(spec.prompt?.parts)) return refused('invalid', 'a prompt is text or Content');
    if (spec.send === true && !text.trim()) return refused('invalid', 'a chat is sent with a prompt');
    const files = spec.attachments === undefined ? [] : spec.attachments;
    if (!Array.isArray(files) || files.length > 20 || !files.every((f) => isRef(f, 'File') || isRef(f, 'Folder'))) return refused('invalid', 'attachments are Files or Folders (at most 20)');
    const NEW = refs.draft(NEW_DRAFT);
    const held = ctx.resident(NEW)?.state.content;
    // the user's draft: its text and its mentions (its attachments are not read on this build: graph-layers.md §3.2)
    const holds = (c) => !!textOf(c) || (c?.parts ?? []).some((x) => x && x.kind !== 'text');
    if (holds(held) && spec.replace !== true) return refused('unavailable', "the new chat holds the user's text: it is not written over (replace: true does)");
    const heldSaid = JSON.stringify(held?.parts ?? []);
    // one window for every step: the one the spec names (where a starter was chosen, public-hooks.md §3.14), else the one chosen for it
    const pinned = spec.window;
    if (pinned !== undefined && !(pinned && pinned.type === 'Window' && pinned.provider === 'codexmods.windows' && /^\d{1,12}$/.test(String(pinned.id)))) return refused('invalid', 'window is a Window');
    const chosen = pinned !== undefined ? { windowId: Number(pinned.id) } : await ctx.chooseWindow?.('Composer', NEW);
    if (chosen?.refused) return chosen.refused;
    const windowId = Number.isSafeInteger(chosen?.windowId) ? chosen.windowId : null;
    if (windowId === null) return refused('unavailable', 'no window to prepare the new chat in');
    const win = { window: { type: 'Window', provider: 'codexmods.windows', id: String(windowId) } };
    const settings = Object.fromEntries([['effort', spec.effort], ['mode', spec.mode], ['access', spec.access]].filter(([, v]) => v !== undefined));
    // 'local': the project's own folder (its LocalEnvironment); a project-less chat has none
    const projectId = agent ? (isRef(spec.project, 'LocalProject') ? spec.project.id : null) : ref.id;
    let environment = spec.environment;
    if (environment === 'local') {
      if (!projectId) return refused('invalid', "'local' is a project's folder: give the project");
      environment = refs.localEnvironment(projectId);
    }
    const target = { project: agent ? (spec.project ?? null) : ref, ...(environment !== undefined ? { environment } : {}),
      ...(spec.branch !== undefined ? { branch: spec.branch } : {}), ...(spec.model !== undefined ? { model: spec.model } : {}), ...(Object.keys(settings).length ? { settings } : {}) };
    const t = await api.setTarget(NEW, target, win);
    if (t) return t;
    // its text, live in that window's composer (shown by the target's navigation, mounted soon after), written only when the editor still
    // holds what it held at the start (read and written in one step in the page: an edit made meanwhile is never written over)
    if (JSON.stringify(ctx.resident(NEW)?.state.content?.parts ?? []) !== heldSaid) return refused('unavailable', 'the new chat changed while it was prepared: not written over (its target was set)');
    let written = null;
    for (let i = 0; i < MODEL_TRIES && !written && !disposed; i++) {
      written = await composerAct(NEW, 'setTextIf', [textOf(held), text], windowId);
      if (written?.status === 'refused' && /changed/.test(written.message ?? '')) return refused('unavailable', 'the new chat changed while it was prepared: not written over (its target was set)');
      if (written?.status !== 'done') { written = null; await pause(MODEL_EVERY_MS); }
    }
    if (!written) return refused('unavailable', "the new chat's composer was not shown (its target was set)");
    for (const f of files) { const r = await api.attach(NEW, f, win); if (r) return r; }
    if (spec.send !== true) return NEW;
    // the editor holds exactly what this operation wrote, read live just before the app's own submit there: the user's edit meanwhile is
    // kept, never sent
    const same = await sameText(NEW, text, windowId);
    if (same) return same;
    return sendNew('submit', { threadId: NEW_DRAFT, windowId, shown: true }, newChat.clientId, { text });
  }

  /**
   * A chat's Draft sent by its own composer (H5x review 1): reached (shown there, or the chat shown by framework-main), then its own submit,
   * live; the app's submit command only where the Host cannot tell what a window shows. The turn it started.
   */
  async function sendIn(ref, p) {
    if (p.refusal) return p.refusal;
    const at = await reach(ref, p);
    if (at.refusal) return at.refusal;
    if (at.unverified) return submit(() => main('submit', { threadId: ref.id, ...inWin(at) }), ref.id, 8000);
    return submit(async () => {
      const out = await composerAct(ref, 'submit', [], at.windowId);
      return out?.status === 'done' ? null : refused('unavailable', out?.message ?? 'its composer cannot send it now');
    }, ref.id, 8000);
  }
  /** A new chat's target (E8.3a: its project); a chat's target is its own. */
  async function setTarget(ref, target, opts) {
    if (!isRef(ref, 'Draft') || ref.id !== NEW_DRAFT) return refused('unsupported', 'only a new chat\'s draft has a target to set');
    if (!target || typeof target !== 'object') return refused('invalid', 'a target {project} is needed');
    // what this build can apply: the project, where it runs, its model and its effort setting; another field (other settings) is said,
    // never dropped quietly
    const settings = target.settings === undefined ? {} : target.settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return refused('invalid', 'settings are {id: value}');
    // the app's new chat is Codex's: another agent's chat is that agent's to start (its Agent.newThread; its own view, graph-integrity G2.2)
    if (target.agent !== undefined && !isRef(target.agent, 'CodexAgent')) return refused('unsupported', 'the app\'s new chat is Codex\'s: another agent\'s chat is started with that agent\'s newThread');
    const other = [...Object.keys(target).filter((k) => !['project', 'agent', 'environment', 'branch', 'model', 'settings'].includes(k) && target[k] !== undefined),
      ...Object.keys(settings).filter((k) => !['effort', 'mode', 'access'].includes(k) && settings[k] !== undefined).map((k) => `${k} setting`)];
    if (other.length) return refused('unsupported', `a new chat's ${other.join(', ')} cannot be set here yet: only its project, environment, branch, model, effort, mode and access`);
    // its access (E8.3f): the permissions menu's own choice (ask for approval, approve for me, custom); full access is the user's
    if (settings.access !== undefined && !['ask', 'approve', 'custom', 'full'].includes(settings.access)) return refused('invalid', 'access is ask, approve or custom');
    if (settings.access === 'full') return refused('unsupported', 'full access is turned on by the user in the composer (the app asks first)');
    const access = settings.access;
    // its mode (E8.3e): plan or default, as its composer's own toggle sets it
    if (settings.mode !== undefined && settings.mode !== 'plan' && settings.mode !== 'default') return refused('invalid', 'a mode is plan or default');
    const collab = settings.mode;
    // its model and effort (E8.3c): a Codex Model the app offers, an effort that model takes (alone: the chosen model's)
    let model;
    const effort = settings.effort;
    if (target.model !== undefined || effort !== undefined) {
      if (target.model !== undefined && !(isRef(target.model, 'Model') && target.model.provider === 'codex')) return refused('unsupported', 'a Codex model is needed');
      const m = target.model !== undefined ? ctx.resident(target.model) : null;
      if (target.model !== undefined && (!m || m.state?.available === false)) return refused('invalid', 'no such model available');
      if (effort !== undefined && (typeof effort !== 'string' || !effort)) return refused('invalid', 'an effort is a name, such as low, medium or high');
      if (m && effort !== undefined && Array.isArray(m.state.efforts) && !m.state.efforts.some((e) => (e?.id ?? e) === effort)) return refused('invalid', `${m.state.name ?? target.model.id} takes the efforts ${m.state.efforts.map((e) => e?.id ?? e).join(', ')}`);
      model = { slug: target.model?.id ?? null, effort: effort ?? null };
    }
    const args = {};
    // no project: a project-less chat (the home page applies it from the route, as the app's own "no project" choice)
    if (target.project === null) args.projectId = null;
    else if (target.project !== undefined) {
      if (!isRef(target.project, 'LocalProject')) return refused('unsupported', 'a local Codex project is needed');
      if (!ctx.resident(target.project)) return refused('invalid', 'no such project');
      args.projectId = target.project.id;
    }
    // where it runs (E8.3b): a project's LocalEnvironment (on this computer, in that project), a new worktree of its project ('worktree',
    // E8.3g: the app makes it when the chat is sent) or a CloudEnvironment; an existing worktree's chat is that WorktreeEnvironment's open()
    let cloudProject;   // the project a cloud environment given here serves (its repository's branches are the cloud chat's)
    if (target.environment === 'worktree') {
      if (args.projectId === null || (args.projectId === undefined && !newChat.project)) return refused('invalid', 'a new worktree is a project\'s: the new chat needs one');
      args.mode = 'worktree';
    } else if (target.environment !== undefined) {
      const env = target.environment;
      const local = isRef(env, 'LocalEnvironment'), cloud = isRef(env, 'CloudEnvironment');
      if (!local && !cloud) return refused('unsupported', 'a new chat runs locally (a project\'s LocalEnvironment), in a new worktree (\'worktree\') or in the cloud (a CloudEnvironment); an existing worktree\'s chat is its open()');
      const got = ctx.resident(env);
      if (!got) return refused('invalid', 'no such environment');
      args.mode = local ? 'local' : 'cloud';
      // a cloud chat has no local project (the app's own cloud entry clears it)
      if (cloud && args.projectId === undefined) args.projectId = null;
      const envProject = got.links?.project && !Array.isArray(got.links.project) ? got.links.project : null;
      if (cloud) {
        cloudProject = envProject?.id ?? null;
        // the exact environment (graph-layers.md §5): the app keeps one cloud environment for every new chat; it is this one when the
        // app stored it, or stored none and the account has only this one; otherwise refused before anything is set
        const name = got.state?.name;
        const mine = (ctx.graph.list('CloudEnvironment') ?? []).filter((x) => x.ref.provider === 'codex' && !x.gone);
        const cur = newChat.cloud;
        // by its id only (two environments may share a name: built review)
        const same = cur ? cur.id === env.id : mine.length === 1 && mine[0].ref.id === env.id;
        if (!same) return refused('unavailable', `a new chat's cloud environment is the app's one choice for every new chat: choose “${name ?? env.id}” in its composer`);
      }
      if (local && envProject && args.projectId === undefined) args.projectId = envProject.id;
      if (local && envProject && args.projectId != null && args.projectId !== envProject.id) return refused('invalid', 'that environment is another project\'s');
    }
    // its starting branch (E8.3g): a new worktree's base or a cloud chat's branch, a Branch of its project (a local chat starts on the
    // project's checked-out one: Repository.switchBranch changes that)
    let branch;
    if (target.branch !== undefined) {
      if (!isRef(target.branch, 'Branch') || target.branch.provider !== 'codex') return refused('unsupported', 'a Branch of a Codex project is needed');
      let b = ctx.resident(target.branch);
      // branches are read when observed: one not read yet is read with its project's repository
      const of = String(target.branch.id).split(':')[0];
      if (!b && of && typeof ctx.readRepository === 'function') { await ctx.readRepository(of); b = ctx.resident(target.branch); }
      if (!b || typeof b.state?.name !== 'string') return refused('invalid', 'no such branch');
      if (args.mode === 'local') return refused('unsupported', 'a local chat starts on the project\'s checked-out branch (Repository.switchBranch changes it); a new worktree or a cloud chat starts from a branch');
      const chatProject = args.projectId !== undefined ? args.projectId : newChat.project;
      const branchProject = b.links?.repository?.id ?? null;
      // a cloud chat's branch is one its environment's repository has: the project that environment serves (review 4)
      if (args.mode === 'cloud') {
        if (!cloudProject || branchProject !== cloudProject) return refused('invalid', 'that cloud environment does not serve that branch\'s project');
      } else if (chatProject) {
        if (branchProject !== chatProject) return refused('invalid', 'that branch is another project\'s');
      } else return refused('invalid', 'a branch is its project\'s: the new chat needs that project, or a cloud environment serving it, in the same call');
      branch = b.state.name;
    }
    if (!Object.keys(args).length && !model && collab === undefined && access === undefined && branch === undefined) return null;
    // One window for the whole operation, chosen before its first step and kept by every step (graph-layers.md §2, §5): the caller's
    // `{window}`, else the window that shows the new chat (the one in front among several), else the window in front. The run location
    // through the composer's own setter when the new chat's composer is shown (the route's seed does not reach an open home page, and
    // the app's cloud entry needs more than its seed); the project first, through the route, as the app's own choice.
    let windowId = windowIdOf(opts);
    if (Number.isNaN(windowId)) return NO_WINDOW;
    if (windowId === null) {
      const chosen = await ctx.chooseWindow?.('Composer', ref);
      if (chosen?.refused) return chosen.refused;
      if (Number.isSafeInteger(chosen?.windowId)) windowId = chosen.windowId;
    }
    const pin = (id) => { if (windowId === null && Number.isSafeInteger(id)) windowId = id; };
    // a new project is the app's selected project before the composer's own setters run (they read the composer of that project); one
    // the app did not select in time is refused, never gone on from (graph-layers.md §5)
    const settled = async () => {
      if (args.projectId === undefined) return null;
      for (let i = 0; i < SETTLE_TRIES && newChat.project !== args.projectId && !disposed; i++) await pause(SETTLE_EVERY_MS);
      if (newChat.project !== args.projectId) return refused('unavailable', 'the app did not select that project for the new chat');
      await pause(SETTLE_EVERY_MS);
      return null;
    };
    const show = async (a) => {
      const r = await showNew({ ...a, ...(windowId !== null ? { windowId } : {}) });
      if (r.refusal) return r.refusal;
      pin(r.windowId);
      return settled();
    };
    const { mode, ...rest } = args;
    if (mode !== undefined) {
      if (Object.keys(rest).length) { const r = await show(rest); if (r) return r; }
      if (!(await live(ref, 'setMode', [mode], windowId, pin))) { const r = await show({ ...rest, mode }); if (r) return r; }
    } else if (Object.keys(args).length) { const r = await show(args); if (r) return r; }
    // the model, then the mode: the new chat's own controls, in that window (the home page is shown when no window shows it); the parts
    // before are already applied when one refuses, which its refusal says
    const before = Object.keys(args).length ? ' (its project and where it runs were set)' : '';
    const onHome = async (ask, what) => {
      let out = await ask();
      if (!out) {
        const r = await show({});
        if (r) return r;
        if (windowId === null) return refused('unavailable', `the new chat's ${what} was not shown${before}`);
        for (let i = 0; i < MODEL_TRIES && !out && !disposed; i++) { await pause(MODEL_EVERY_MS); out = await ask(); }
      }
      pin(out?.windowId);
      if (!out) return refused('unavailable', `the new chat's ${what} was not shown${before}`);
      return out.status === 'done' ? null : refused('unavailable', `${out.message ?? `the ${what} did not take it`}${before}`);
    };
    if (model) { const r = await onHome(() => chooseModel(model.slug, model.effort, windowId), 'model menu'); if (r) return r; }
    if (collab !== undefined) { const r = await onHome(() => composerAct(ref, 'setCollaborationMode', [collab], windowId), 'composer'); if (r) return r; }
    // access (graph-layers.md §5): ask and approve are the local host's selection the app keeps, written as its menu writes it (every
    // composer of the host shows it; no menu, so no other menu's rows); custom through the menu, which says whether the host offers it
    if (access !== undefined && access !== 'custom') { const r = await main('set-access', { access }); if (r) return r; }
    if (access === 'custom') { const r = await onHome(() => composerAct(ref, 'setAccess', [access], windowId), 'permissions menu'); if (r) return r; }
    if (branch !== undefined) { const r = await onHome(() => composerAct(ref, 'setBranch', [branch], windowId), 'branch picker'); if (r) return r; }
    return null;
  }
  const api = {
    start() {
      if (disposed) return;
      if (!timer) { timer = setInterval(readPrompts, 2 * 60_000); timer.unref?.(); }
      return readPrompts();
    },
    observe(ref, concept) {
      if (concept === 'Draft' && !threadDraft(ref)) {
        if (!ctx.resident(ref)) applyDraft(ref.id, saved.get(ref.id) ?? null, true);
        return Promise.resolve();
      }
      if (concept === 'Command' && ref.type === 'SlashCommand') return reading ?? (ctx.now() - readAt >= 30_000 ? readPrompts() : Promise.resolve());
      return undefined;
    },
    responded(method) {
      if (disposed || !THREAD_READS.has(method)) return;
      everyChat();   // the chats a read put: their drafts, with what the app saved
    },
    notified(method, p) {
      if (disposed) return;
      if (method === 'thread/started') everyChat();
      if (method === 'turn/started' && p?.turn?.id) turns.set(p.threadId, ctx.now());
      for (const wait of pending) {
        if (method !== wait.method) continue;
        if (method === 'turn/started' && p?.threadId === wait.threadId && p.turn?.id) wait.resolve(refs.turn(p.turn.id));
        else if (method === 'thread/started' && p?.thread?.id) {
          const is = startedFor(p.thread, wait.expect);
          if (is === true) wait.resolve(refs.thread(p.thread.id));
          else if (is === 'maybe') wait.candidate = p.thread.id;
        }
      }
    },
    prompt(op, ref, arg) {
      if (!ctx.serverUp()) return null;
      if (op === 'send') {
        if (threadDraft(ref) || ref.id === PANEL_DRAFT) return null;   // refused without asking
        if (ref.id === NEW_DRAFT) {
          const st = ctx.resident(ref)?.state;
          const project = st?.target?.project ? ctx.resident(st.target.project)?.state.name : null;
          return { action: `start a chat${project ? ` in “${project}”` : ''} with “${textOf(st?.content).slice(0, 60)}”`, detail: DETAIL };
        }
        if (ctx.isEphemeral?.(ref.id)) return null;   // refused without asking
        return { action: `send the draft in “${ctx.resident(chatOf(ref.id))?.state.title}”`, detail: DETAIL };
      }
      if (op === 'run') {
        if (runCheck(arg)) return null;
        return { action: `run “/${ref.id}” in “${ctx.resident(arg.thread)?.state.title}”`, detail: DETAIL };
      }
      if (arg === undefined || (op === 'agent' && (ref.type !== 'CodexAgent' || ref.id !== 'codex'))) return null;
      // a spec: asked only when it sends (preparing a draft changes what the user sees, not what Codex does)
      if (arg && typeof arg === 'object' && !Array.isArray(arg) && !('type' in arg)) {
        if (arg.send !== true) return null;
        const text = typeof arg.prompt === 'string' ? arg.prompt : textOf(arg.prompt);
        const project = op === 'project' ? ctx.resident(ref)?.state.name : arg.project ? ctx.resident(arg.project)?.state.name : null;
        return { action: `start a chat${project ? ` in “${project}”` : ''} with “${text.slice(0, 60)}”`, detail: DETAIL };
      }
      const s = seed(arg, op === 'agent');
      return s.status ? null : { action: `start a chat with “${s.text.slice(0, 60)}”`, detail: DETAIL };
    },
    // `opts.window`: the operation stays in that window: its composer of this Draft, live, or nothing (never the app's messages, which
    // reach another window's composer)
    // Each acts in one place (placeOf): that window's composer of this Draft, live (no navigation, no wait), else the app's own messages
    // to that window (never another window's composer); a window named that does not show it: refused.
    // `{ifEmpty: true}`: written only while the draft holds nothing (writeIfEmpty)
    /** An operation that names a pane runs with it: what it acts on is that pane's composer (layouts.md D8). */
    inPane: (opts, fn) => (typeof ctx.withPane === 'function' ? ctx.withPane(opts && typeof opts === 'object' && typeof opts.pane === 'string' ? opts.pane : null, fn) : fn()),

    async setContent(ref, content, opts) {
      const invalid = threadDraft(ref);
      if (invalid) return invalid;
      const ifEmpty = opts && typeof opts === 'object' ? opts.ifEmpty : undefined;
      if (ifEmpty !== undefined && typeof ifEmpty !== 'boolean') return refused('invalid', 'ifEmpty is true or false');
      const p = await placeOf(ref, opts);
      if (p.refusal) return p.refusal;
      const args = input(content);
      if (ifEmpty) return writeIfEmpty(ref, p, args);
      return edit(ref, p, stepsOf(true, args), (w) => main('set-text', { threadId: ref.id, ...args, ...w }));
    },
    async insert(ref, content, opts) {
      const invalid = threadDraft(ref);
      if (invalid) return invalid;
      const p = await placeOf(ref, opts);
      if (p.refusal) return p.refusal;
      const args = input(content);
      if (!args.text && !args.skills.length) return refused('invalid', 'text or a skill is needed');
      return edit(ref, p, stepsOf(false, args), (w) => main('insert', { threadId: ref.id, ...args, ...w }));
    },
    // What is attached (public-hooks.md F4): a File or Folder (the app's file attachment); a Skill (its chip); `{text, name?}` (a file the
    // framework writes, attached as a file); `{url, title?}` (the link in the text where the cursor is, after its title: `Spec: https://…`)
    async attach(ref, what, opts) {
      const invalid = threadDraft(ref);
      if (invalid) return invalid;
      const kind = attachKind(what);
      if (kind.refusal) return kind.refusal;
      const p = await placeOf(ref, opts);
      if (p.refusal) return p.refusal;
      // two composers of it in that window (one kept out of sight): `live` says which one is not known, and nothing else is tried
      try { return await attachIn(ref, p, kind); } catch (e) { if (e.refusal) return e.refusal; throw e; }
    },
    /** Attachment.remove (H8d): a draft's attachment taken out by the composer that shows it, as its tray's own remove does. */
    async removeAttachment(ref) {
      const key = attachmentKeys.get(ref.id);
      if (!key) return refused('unsupported', 'only a draft\'s attachment is removed here (a sent message\'s stays)');
      // in the composer of the window whose tray listed it
      const out = await ctx.pageAct?.('Composer', refs.draft(key.draftId), 'removeAttachment', [key.itemId], key.windowId ?? null);
      if (!out) return refused('unavailable', 'no composer shows its draft now');
      if (out.status === 'done') return null;
      if (out.status === 'refused') return refused('unavailable', out.message ?? 'its composer could not remove it');
      throw new Error(`the composer did not say whether it removed it: ${out.error?.message ?? 'no answer'}`);
    },
    async clear(ref, opts) {
      const invalid = threadDraft(ref);
      if (invalid) return invalid;
      const p = await placeOf(ref, opts);
      if (p.refusal) return p.refusal;
      return edit(ref, p, [['clear', []]], (w) => main('clear', { threadId: ref.id, ...w }));
    },
    async send(ref, opts) {
      if (!ctx.serverUp()) return ctx.DOWN;
      const invalid = threadDraft(ref);
      if (invalid) return invalid;
      const p = await placeOf(ref, opts);
      if (p.refusal) return p.refusal;
      // the composer already shown there: the app's own submit in that window, with no navigation (so no wait the user could type in)
      const inWindow = { ...inWin(p), ...(p.shows && p.windowId !== null ? { shown: true } : {}) };
      if (ref.id === PANEL_DRAFT) return refused('unsupported', "the panel's new chat is sent from its composer");
      // a new chat's draft starts a chat: its result is the Thread
      if (ref.id === NEW_DRAFT) {
        const text = textOf(ctx.resident(ref)?.state.content);
        if (!text) return refused('invalid', 'the new chat\'s draft has no text');
        // shown there: it holds this text now (the live editor read), just before the app's own submit (built review, round 2)
        if (inWindow.shown) { const r = await sameText(ref, text, p.windowId); if (r) return r; }
        return sendNew('submit', { threadId: ref.id, ...inWindow }, newChat.clientId, { text });
      }
      if (ctx.isEphemeral?.(ref.id)) return SIDE_SEND;
      return sendIn(ref, p);
    },
    setTarget,
    async use(skill, draft) {
      const invalid = threadDraft(draft);
      if (invalid) return invalid;
      if (!skill.state.installed) return refused('unsupported', 'the skill must be installed');
      // its chip, as Draft.attach(skill) puts it: in the Draft's own composer (H5x review 1), never another's
      const p = await placeOf(draft, undefined);
      if (p.refusal) return p.refusal;
      const chip = { name: skill.state.name, path: skill.ref.id };
      return edit(draft, p, [['insertSkill', [chip]]], (w) => main('insert', { threadId: draft.id, text: '', skills: [chip], ...w }));
    },
    async newThread(ref, arg, agent = false) {
      // a chat's spec (graph-layers.md §3.2): prepared, and sent when asked, one at a time
      if (arg !== undefined && arg !== null && typeof arg === 'object' && !Array.isArray(arg) && !('type' in arg)) {
        const run = preparing.then(() => prepare(ref, arg, agent));
        preparing = run.catch(() => {});
        return run;
      }
      return fromDraft(ref, arg, agent);
    },
    async run(ref, args) {
      if (!ctx.serverUp()) return ctx.DOWN;
      const invalid = runCheck(args);
      if (invalid) return invalid;
      const threadId = args.thread.id;
      // the command's text in the chat's own composer, then its own send (H5x review 1)
      const draft = refs.draft(threadId);
      const p = await placeOf(draft, undefined);
      if (p.refusal) return p.refusal;
      const text = `/${ref.id}${args.arguments ? ` ${args.arguments}` : ''}`;
      const r = await edit(draft, p, [['insert', [text]]], (w) => main('insert', { threadId, text, ...w }));
      if (r) return r;
      const sent = await sendIn(draft, await placeOf(draft, undefined));
      if (sent?.status === 'refused') return sent;
      ctx.emitEvent(ref, 'ran');
      return null;
    },
    dispose() { disposed = true; reports.dispose(); told?.dispose?.(); traySub?.dispose?.(); clearInterval(timer); clearTimeout(defaultsTimer); defaultsSub?.dispose(); for (const wait of pending) wait.resolve(null); pending.clear(); },
  };
  return api;
}
