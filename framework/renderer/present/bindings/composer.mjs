// Composer (docs/graph/03): where you write to the agent. On 21477 the chat's composer builds its footer in one component (the one whose
// props carry `viewProps`, `inputStatus`, `addContextButton`, `showPermissionsModeDropdown` and `emptySubmitTooltipNonce`, which nothing
// else carries); its props say nothing of the chat, so the address reads ComposerScope, whose value says which composer it is: every
// composer presents its Draft (E8.3, `draftOf`): a chat's, main or side, its thread's; a new chat's, the app's draft key's. Its pickers
// slot (systems.md S15, E3) is the node the footer renders right after the model picker (`hotkeyWindowHomeFooterControls`): the app's own
// stays first, the mods' thread-scope settings follow (composer-pickers.mjs); a new chat's, its provided agent's own settings (§3.15).
// E7.2, the card's slots: `toolbar`, actions after the app's "+" (`addContextButton`); `pickers`, controls a mod hosts beside the pickers
// (in that same node, before the framework's own); `aboveInput`, the card's header (`viewProps.header`, before the attachments and the
// input); `belowInput`, regions after the composer's card (the footer renders the whole card, its editor included, so it stays the first
// and unkeyed child: a region coming or going never remounts the editor). NO NODE API.
import { textOfDoc } from '../../../shared/draft-text.mjs';
import { defineBinding } from '../runtime.mjs';
import { createComposerPickers } from '../composer-pickers.mjs';
import { nodeList, nodeRegion, appendNodes, actionNode, SIBLINGS, withoutSiblings, statusList } from './slots.mjs';
import { choicesPlan, applyChoices, madeOf } from '../choices.mjs';

/** The thread of a chat's main composer, from its ComposerScope value; null for any other composer (home, side chat, cloud, ...). */
const chatThread = (ctx, scope) => (scope && scope.kind === 'local' && scope.placement === 'main' && typeof scope.conversationId === 'string' && scope.conversationId
  ? ctx.thread(scope.conversationId) ?? null : null);
/** A new chat's draft key, as the app computes it from the scope (mod-surfaces.md §3.6): the home page's, else the panel page's. */
export const newKey = (scope) => (scope.entrypoint === 'panel' ? 'panel-new-conversation'
  : scope.entrypoint === 'home' ? scope.homeDraftKey ?? scope.draftThreadLocationId ?? (scope.gptId == null ? 'new-conversation' : null) : null);
/**
 * The Draft every composer writes (E8.3): a chat's, main or side, is its thread's, a provided chat's too (public-hooks.md §3.15: the app's
 * draft key, the protocol id the app knows it by); a new chat's is the app's draft key's (the main and the hotkey window's home share
 * `new-conversation`). A pending chat's (no thread yet) and the ChatGPT composers' name none.
 */
export function draftOf(ctx, scope) {
  if (!scope) return null;
  if (scope.kind === 'local' && typeof scope.conversationId === 'string' && scope.conversationId) {
    return ctx.thread(scope.conversationId) ? { type: 'Draft', provider: 'codex', id: scope.conversationId.replace(/^local:/, '') } : null;
  }
  const key = scope.kind === 'new' ? newKey(scope) : null;
  return key === 'new-conversation' || key === 'panel-new-conversation' ? { type: 'Draft', provider: 'codex', id: `new:app:${key}` } : null;
}
/** A chat's Draft's chat, as the graph names it (a provided chat's is its provider's Thread, H5x review 1); null for a new chat's. */
function chatOf(ctx, draft) {
  const t = draft && !draft.id.startsWith('new:') ? ctx.thread(draft.id) : null;
  return t ? { type: t.type, provider: t.provider, id: t.id } : null;
}
const pickers = new WeakMap();   // the runtime's ctx -> its pickers (one set per window)
const pickersOf = (ctx, R) => { let p = pickers.get(ctx); if (!p) { p = createComposerPickers({ R, ctx, exports: ctx.exports }); pickers.set(ctx, p); } return p; };

/** The card's header (inside `viewProps`): the hosted regions after what the app puts there. */
const headerRegion = {
  kind: 'region',
  apply: (props, nodes, env) => (props.viewProps && typeof props.viewProps === 'object'
    ? { ...props, viewProps: { ...props.viewProps, header: appendNodes(env.R, props.viewProps.header, nodes) } } : props),
};
/** Regions after the composer's card, beside the bound component (never passed to it). */
const afterRegion = { kind: 'region', apply: (props, nodes) => ({ ...props, [SIBLINGS]: [...(props[SIBLINGS] ?? []), ...nodes] }) };

// a chat's composer is in its ThreadView; a new chat's in the NewThreadView of its draft (its parts are the same presentation: same place)
const composerPlace = (props, scope) => (scope && scope.kind === 'new' ? { in: 'NewThreadView', slot: 'composer' } : { in: 'ThreadView', via: 'thread', slot: 'composer' });
export const composer = defineBinding({
  id: 'composer', presentation: 'Composer',
  place: composerPlace,
  presents: ['Draft'],
  subject: (props, ctx, scope) => draftOf(ctx, scope),
  slots: {
    toolbar: nodeList('addContextButton', ({ R, ctx }, item, key) => actionNode(R, ctx, item, key), { field: 'actions' }),
    // ui.status (public-hooks.md §3.14): the mods' statuses in the footer's inline controls, before the pickers mods host
    status: statusList((props, nodes, env) => ({ ...props, hotkeyWindowHomeFooterControls: appendNodes(env.R, props.hotkeyWindowHomeFooterControls, nodes) })),
    pickers: nodeRegion('hotkeyWindowHomeFooterControls'),
    aboveInput: headerRegion,
    belowInput: afterRegion,
  },
  // the app's own parts (public-hooks.md §3.10, 21477): the "+" (its node prop) and dictation (its visibility in the voice controls); the
  // model menu is its own binding's (picker.model)
  appParts: {
    attach: (p) => ({ ...p, addContextButton: null }),
    dictate: (p) => (p.voiceControls && typeof p.voiceControls === 'object' ? { ...p, voiceControls: { ...p.voiceControls, isDictationButtonVisible: false } } : p),
  },
  render(Original, props, factory, ctx, scope) {
    const t = chatThread(ctx, scope);
    const R = ctx.react();
    const [own0, after0] = withoutSiblings(props);
    // a composer's send, by its Send button or its Enter key, is held first (public-hooks.md §3.5), a new chat's and a chat's (graph-integrity
    // G6.2: where a mod stops the user's send quietly): it passes the mods' interceptors and policies as the user's Draft.send before the
    // app does anything; a refusal keeps the text, with the reason under the composer; a stop keeps it, with no word
    const draft = draftOf(ctx, scope);
    const own = draft ? heldSubmits(ctx, draft, own0) : own0;
    const after = draft && R ? [...after0, ...sendRefusal(R, ctx, draft), ...suggestions(R, ctx, own0, draft)] : after0;
    if (!t || !R) return after.length && R ? R.createElement(R.Fragment, null, factory(Original, own), ...after) : (after.length || own !== own0 ? factory(Original, own) : undefined);
    const p = pickersOf(ctx, R);
    // The card first and unkeyed, then the regions after it: React unwraps an unkeyed fragment and matches the card with the element
    // before it, so the editor inside keeps its state whether regions come or go (and when the runtime starts after the app's first render).
    return R.createElement(R.Fragment, null, factory(Original, { ...own, hotkeyWindowHomeFooterControls: p.nodeFor(t, own.hotkeyWindowHomeFooterControls) }), ...after);
  },
  // The Draft's live operations (E8.3b): the composer's own controller (the app's context its footer sits in, `context` in the address,
  // kept on the mount's record), so a Draft is written where it is shown, with no navigation and no wait. Without a controller (another
  // build, a composer that is gone) each says it cannot, and the Host uses the app's own messages.
  operations: {
    setText(props, [text], ctx, rec) { const c = controllerOf(rec, 'setText'); if (!c) return false; c.setText(String(text ?? '')); return true; },
    insert(props, [text], ctx, rec) { const c = controllerOf(rec, 'insertTextAtSelection'); if (!c) return false; c.insertTextAtSelection(String(text ?? '')); return true; },
    clear(props, args, ctx, rec) { const c = controllerOf(rec, 'setText'); if (!c) return false; c.setText(''); return true; },
    // Its own send (H5x review 1): its editor's submit, the one its Enter key runs (it finishes a dictation first: review 2), else the
    // footer's, which its Send button runs; so this composer's draft is the one sent (the app's submit command sends the window's active
    // composer's, which may be another: a side chat's)
    submit(props) {
      const f = typeof props.viewProps?.editor?.onSubmit === 'function' ? props.viewProps.editor.onSubmit : props.handleSubmit;
      if (typeof f !== 'function') return false;
      f();
      return true;
    },
    // A skill's chip where the cursor is, as the app's own message for it does, in this composer (review 2: never another's)
    insertSkill(props, [skill], ctx, rec) {
      const c = controllerOf(rec, 'insertMentionAtSelection');
      if (!c) return false;
      if (!skill || typeof skill.name !== 'string' || typeof skill.path !== 'string') return { unavailable: 'not a skill' };
      c.insertMentionAtSelection({ kind: 'skill', name: skill.name, displayName: skill.name, path: skill.path, description: '', iconSmall: null });
      return true;
    },
    // Focus in its editor, so the app's own messages (a skill's chip, a file) reach it: they go to the window's last focused composer
    focus(props, args, ctx, rec) {
      const view = rec?.context?.view;
      if (!view || typeof view.focus !== 'function' || cannotTakeFocus(ctx)) return false;
      view.focus();
      return view.hasFocus?.() !== false;   // a hidden or inert tab's editor takes none: the app's message would reach whichever has it
    },
    // The live guards of a Draft written for a mod (graph-layers.md §3.2): the editor's own document read and written in one step, so no
    // edit of the user's can come between (what a mod is told was there is what was there).
    setTextIf(props, [expected, text], ctx, rec) {
      const c = controllerOf(rec, 'setText');
      const said = c ? liveText(c) : null;
      if (said === null) return false;
      if (said !== String(expected ?? '')) return { unavailable: 'changed: the draft holds something else now' };
      c.setText(String(text ?? ''));
      return true;
    },
    textIs(props, [expected], ctx, rec) {
      const said = liveText(controllerOf(rec, 'setText'));
      if (said === null) return false;
      return said === String(expected ?? '') ? true : { unavailable: 'changed: the draft holds something else now' };
    },
    // A file attached as the app's own message does, told here: its editor focused and the message given in one step, so nothing can come between and it reaches this very
    // composer (the message goes to the window's active composer). Not while a queued message is edited there (its editor is that message's).
    attachFile(props, [file], ctx, rec) {
      const view = rec?.context?.view;
      const Bus = ctx.exports?.()?.bus;
      const bus = typeof Bus?.getInstance === 'function' ? Bus.getInstance() : null;
      if (!view || typeof view.focus !== 'function' || typeof bus?.dispatchHostMessage !== 'function' || cannotTakeFocus(ctx)) return false;
      if (Array.isArray(trayOf(props)?.attachmentOrder)) return { unavailable: 'a queued message is being edited in this composer' };
      view.focus();
      // a hidden or inert tab's editor takes none: the message would reach whichever has it
      if (view.hasFocus?.() === false) return false;
      bus.dispatchHostMessage({ type: 'add-context-file', file });
      return true;
    },
    // An image attached as the app's own paste does (H8d): the composer's paste event with the image as a File (saved and shown by the
    // app's own path: its tray, its upload). Not while a queued message is edited there (the tray is that message's).
    attachImage(props, [dataUrl, name]) {
      const c = props.viewProps?.editor?.composerController;
      const tray = trayOf(props);
      if (!c?.eventEmitter || typeof c.eventEmitter.emit !== 'function') return false;
      if (tray && Array.isArray(tray.attachmentOrder)) return { unavailable: 'a queued message is being edited in this composer' };
      if (tray && tray.supportsImageInputs === false) return { unavailable: 'this composer takes no images (its model)' };
      const file = fileOfDataUrl(dataUrl, name);
      if (!file) return { unavailable: 'not an image this composer takes' };
      c.eventEmitter.emit('pasted-images', [file]);
      return true;
    },
    // One of its attachments removed, as its tray's own remove does (an image by its id, a file by its place): the file is found again by
    // its identity in the tray as it is now, so one that went (and the place another took) is never removed in its stead.
    removeAttachment(props, [id]) {
      const tray = trayOf(props);
      if (!tray || Array.isArray(tray.attachmentOrder)) return { unavailable: 'this composer\'s attachments are not its draft\'s now' };
      const [src, key] = [String(id).slice(0, String(id).indexOf(':')), String(id).slice(String(id).indexOf(':') + 1)];
      const remove = src === 'image' ? tray.handleRemoveImage : src === 'picked' ? tray.handleRemoveFileAttachment : src === 'added' ? tray.handleRemoveFile : null;
      if (typeof remove !== 'function') return { unavailable: 'no such attachment' };
      if (src === 'image') {
        const img = (tray.shownImages ?? []).find((x) => String(x?.id) === key);
        if (!img) return { unavailable: 'the attachment is gone' };
        remove(img.id);
      } else {
        const list = src === 'picked' ? tray.shownFiles : tray.addedFiles;
        const i = Array.isArray(list) ? list.findIndex((f) => fileKey(f) === key) : -1;
        if (i < 0) return { unavailable: 'the attachment is gone' };
        remove(i);
      }
      return true;
    },
  },
  windowFacts: (ctx) => ({ attachments: attachmentsOf(ctx) }),
});
const sendRefusals = new Map();   // a new chat's Draft id -> why its send was refused (said until the next send goes)
/**
 * The footer's Send (`handleSubmit`) and the editor's Enter (`viewProps.editor.onSubmit`), each the user's Draft.send (a new chat's or a
 * chat's): held while something holds it (a change of it cannot be carried out here, so the Host refuses one), else the app's own at once.
 */
function heldSubmits(ctx, draft, props) {
  if (typeof ctx.userAction !== 'function') return props;
  const key = `local:send-refusal:${draft.id}`;
  const say = (h) => {
    // stopped by a mod (graph-integrity G6.2): no word of it, and the composer keeps its text, as it does when refused
    if (h.go === false && !h.handled && !h.stopped) { sendRefusals.set(draft.id, String(h.message ?? 'not allowed')); ctx.local?.touch(key); return; }
    if (sendRefusals.delete(draft.id)) ctx.local?.touch(key);
  };
  const editor = props.viewProps?.editor;
  // the send names what it sends (`{content}`, the composer's text as it is now: the Draft's own content is saved a moment later), so the
  // mods' interceptors judge the message itself (reference-mods.md RM8)
  const now = () => { const t = liveText(editor?.composerController); return typeof t === 'string' ? [{ content: { parts: [{ kind: 'text', text: t }] } }] : []; };
  const held = (fn) => (typeof fn !== 'function' ? fn : (...a) => ctx.userAction(draft, 'send', now(), () => fn(...a), { said: say }));
  const out = { ...props };
  if (typeof props.handleSubmit === 'function') out.handleSubmit = held(props.handleSubmit);
  if (editor && typeof editor.onSubmit === 'function') out.viewProps = { ...props.viewProps, editor: { ...editor, onSubmit: held(editor.onSubmit) } };
  return out;
}
/** Why the new chat's last send was refused, under the composer (the theme's secondary text), or nothing. */
function sendRefusal(R, ctx, draft) {
  ctx.local?.read(`local:send-refusal:${draft.id}`);
  const why = sendRefusals.get(draft.id);
  if (!why) return [];
  const color = ctx.token?.('textSecondary');
  return [R.createElement('div', { key: 'codexmods-send-refused', 'data-codexmods-refused': '', ...(color ? { style: { color } } : {}) }, `Not sent: ${why}`)];
}
/** What the composer's editor holds now, as the Host says a draft's text (shared/draft-text.mjs), or null when it cannot be read. */
const liveText = (c) => { try { const doc = c?.view?.state?.doc; return doc && typeof doc.toJSON === 'function' ? textOfDoc(doc.toJSON()) : null; } catch { return null; } };
/** The mods' inline suggestions on this composer (ui.composer.suggest, RM8): an element that follows its editor (its own controller). */
function suggestions(R, ctx, props, draft) {
  const cs = ctx.composerSuggestions?.();
  const c = props?.viewProps?.editor?.composerController;
  if (!cs || !c || typeof c !== 'object' || !c.view || typeof c.insertTextAtSelection !== 'function') return [];
  return [R.createElement(cs.Attach, { key: 'codexmods:suggest', controller: c, draft, thread: chatOf(ctx, draft) })];
}
/** The composer's live controller on a mount's record, when it has the method. */
const controllerOf = (rec, method) => { const c = rec && rec.context; return c && typeof c === 'object' && typeof c[method] === 'function' ? c : null; };

// A composer's attachments (public-hooks.md H8d; scout H8d-attachments): its attachment tray's own view model, which the composer's card
// is given as `viewProps.attachments` (one component for every composer: a chat's, the new chat's, a side chat's). Images by the tray's
// id; files picked with "+" (`shownFiles`) and dropped or pasted (`addedFiles`) by their place, as the tray's remove handlers take them.
const trayOf = (props) => { const t = props?.viewProps?.attachments?.props; return t && typeof t === 'object' ? t : null; };
const fileName = (f, i) => String(f?.label ?? (String(f?.fsPath ?? f?.path ?? '').split('/').pop() || `file ${i + 1}`)).slice(0, 300);
const filePath = (f) => (typeof (f?.fsPath ?? f?.path) === 'string' ? f.fsPath ?? f.path : null);
/** A file's identity in the tray: its path, else one of its own for the object the tray holds (never a place another can take). */
const fileIds = new WeakMap();
let fileSeq = 0;
const fileKey = (f) => {
  const p = filePath(f);
  if (p) return `path:${p}`;
  if (!f || typeof f !== 'object') return null;
  if (!fileIds.has(f)) fileIds.set(f, `own:${++fileSeq}`);
  return fileIds.get(f);
};
/** The tray's attachments as the Host keeps them: [{id, kind, name, path?}]; null while a queued message is edited there (its own). */
export function trayItems(tray) {
  if (!tray || Array.isArray(tray.attachmentOrder)) return null;   // editing a queued message: the tray shows that message's
  const files = (list, src) => (Array.isArray(list) ? list : []).flatMap((f, i) => { const k = fileKey(f); return k ? [{ id: `${src}:${k}`, kind: 'file', name: fileName(f, i), ...(filePath(f) ? { path: filePath(f) } : {}) }] : []; });
  return [
    ...(Array.isArray(tray.shownImages) ? tray.shownImages : []).filter((img) => img && img.id != null)
      .map((img) => ({ id: `image:${img.id}`, kind: 'image', name: String(img.filename || 'image').slice(0, 300), ...(typeof img.localPath === 'string' && img.localPath ? { path: img.localPath } : {}) })),
    ...files(tray.shownFiles, 'picked'), ...files(tray.addedFiles, 'added'),
  ];
}
/** Each shown composer's attachments by the Draft it shows (sent with the window's reports): its first composer's, where it shows twice. */
export function attachmentsOf(ctx) {
  const out = {};
  for (const m of typeof ctx.mountsOf === 'function' ? ctx.mountsOf('composer') : []) {
    const d = m.props ? draftOf(ctx, m.scope) : null;
    if (!d || Object.hasOwn(out, d.id)) continue;
    const items = trayItems(trayOf(m.props));
    if (items) out[d.id] = items;
  }
  return out;
}
/** A data URL's bytes as a File (the composer's paste takes Files). */
function fileOfDataUrl(dataUrl, name) {
  const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(dataUrl));
  if (!m) return null;
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], String(name), { type: m[1] });
}

/**
 * The composer's slash menu (the Palette of its Draft, docs/graph/03; mod-surfaces.md §3.6, E8.6): on 21477 every composer renders its
 * suggestion overlay once (its props carry `contextualSuggestionUi`, `contextualSuggestions`, `skillSuggestions`, `hideSideSlashCommand`,
 * `overlayAnchorRef`). The binding names the composer's Draft and mounts, beside the overlay (after it, unkeyed first so nothing remounts),
 * the registrar that registers the mods' slash commands as this composer's own items (present/slash-items.mjs).
 */
/**
 * A window not in front fires no focus event, so the app's active composer stays what it was: with another composer here, its messages could reach that one. With this one alone they
 * can only reach it.
 */
const cannotTakeFocus = (ctx) => globalThis.document?.hasFocus?.() === false && (ctx.mountsOf?.('composer')?.length ?? 0) !== 1;

export const composerSuggest = defineBinding({
  id: 'composer.suggest', presentation: 'Palette',
  place: { in: 'Composer', slot: 'palette' },
  presents: ['Draft'],
  subject: (props, ctx, scope) => draftOf(ctx, scope),
  render(Original, props, factory, ctx, scope) {
    const si = ctx.slashItems?.();
    const R = ctx.react?.();
    if (!si || !R) return undefined;
    const draft = draftOf(ctx, scope);
    const thread = chatOf(ctx, draft);
    return R.createElement(R.Fragment, null, factory(Original, props), R.createElement(si.Registrar, { key: 'codexmods-slash', draft, thread }));
  },
});

/**
 * The composer's "@" list (the Palette of its Draft; mod-surfaces.md §3.6, E8.6b): on 21477 one component draws it, given the list's
 * sections (its props carry `sections`, `query`, `onAddContext`, `onUpdateSelectedMention`, `keyboardEventTarget` and six more, exactly).
 * The binding names the composer's Draft and renders the list with the mods' mention sections spliced into the app's (present/mention-sources.mjs).
 */
export const mentionList = defineBinding({
  id: 'mention.list', presentation: 'Palette',
  place: { in: 'Composer', slot: 'palette' },
  presents: ['Draft'],
  subject: (props, ctx, scope) => draftOf(ctx, scope),
  render(Original, props, factory, ctx, scope) {
    const ms = ctx.mentionSources?.();
    const R = ctx.react?.();
    if (!ms || !R) return undefined;
    const draft = draftOf(ctx, scope);
    const thread = chatOf(ctx, draft);
    return R.createElement(ms.Splice, { Original, props, factory, draft, thread });
  },
});

/**
 * The composer's run location (where a new chat runs: on this computer, in a new worktree, in the cloud; E8.3b): on 21477 the bar below a
 * composer is given the mode and the app's own setter (`composerMode`, `setComposerMode`, with the worktree's context). A part of the
 * Composer of the composer's Draft: its `setMode` is the Draft's run location set the way the user's choice sets it.
 */
// The new chat's plan mode (E8.3e; scout E8-newchat-target §2): the inner composer holds the mode's setter as a prop (both ways, as the
// app's own plan toggle and its "plan mode" chip use it); a part of the Composer of its Draft (ComposerScope), with `setCollaborationMode`
// among the modes the composer offers ('default' with none offered is the app's own "no selection").
export const composerMode = defineBinding({
  id: 'composer.mode', presentation: 'Composer', part: true, presents: ['Draft'], place: composerPlace,
  subject: (props, ctx, scope) => draftOf(ctx, scope),
  operations: {
    setCollaborationMode(props, [mode]) {
      if (typeof props.setSelectedCollaborationMode !== 'function' || !Array.isArray(props.collaborationModes)) return { unavailable: 'this composer has no mode to set' };
      const modes = props.collaborationModes.map((m) => m && m.mode);
      if (mode === 'plan' && !modes.includes('plan')) return { unavailable: 'this composer offers no plan mode' };
      if (mode !== 'plan' && mode !== 'default') return { unavailable: 'a mode is plan or default' };
      props.setSelectedCollaborationMode(mode === 'default' && !modes.includes('default') ? null : mode);
      return true;
    },
  },
});
// The new chat's access (E8.3f; scout E8-newchat-target §1): its permissions menu (the footer's dropdown) holds no setter, its rows do
// (`selectPermission`, the app's own choice), and they mount only while the menu is open: `setAccess` opens it, takes the app's row for the
// access asked, and the app closes it. Full access stays the user's (the app asks first, in its own dialog); a disabled row is refused.
const ACCESS = { ask: (s) => s.kind === 'agent-mode' && ['read-only', 'auto', 'granular'].includes(s.agentMode), approve: (s) => s.kind === 'agent-mode' && s.agentMode === 'guardian-approvals', custom: (s) => s.kind === 'custom' };
// the menu's older form (a build's gate chooses it): generic items with their own click, named by their messages' ids
const LEGACY = { ask: 'composer.permissionsDropdown.default.', approve: 'composer.permissionsDropdown.guardianApproval.', custom: 'composer.permissionsDropdown.custom.' };
/** The message ids an item's label and subtext hold (a few levels of elements). */
function messageIds(v, out = [], depth = 0) {
  if (!v || typeof v !== 'object' || depth > 4) return out;
  if (Array.isArray(v)) { for (const x of v) messageIds(x, out, depth + 1); return out; }
  const p = v.props;
  if (p && typeof p.id === 'string') out.push(p.id);
  if (p) { messageIds(p.children, out, depth + 1); }
  return out;
}
const ROW_WAIT_MS = 1500, ROW_EVERY_MS = 50;
// ui.choices of access (public-hooks.md §3.11; scout H4-choices §2.2): the menu takes a container the app renders around the finished menu
// (`DropdownContainer`, given { children }); the framework's rewrites the menu's rows: an access mode a mod hides is not offered (the
// selected one stays), the order applies among the modes, a legacy row takes its new label and subtext, and a mod's entry (the app's own
// menu item) runs its callback. Rows are named as `setAccess` names them: ask, approve, full, custom, profile:<id>, default.
const ACCESS_ID = { 'read-only': 'ask', auto: 'ask', granular: 'ask', 'guardian-approvals': 'approve', 'full-access': 'full' };
const LEGACY_ID = [['composer.permissionsDropdown.default.', 'ask'], ['composer.permissionsDropdown.guardianApproval.', 'approve'], ['composer.permissionsDropdown.fullAccess.', 'full'], ['composer.permissionsDropdown.custom.', 'custom']];
/** The access mode a row of the menu offers, or null for anything else (its title, a separator). */
function accessIdOf(el) {
  const p = el && typeof el === 'object' ? el.props : null;
  if (!p) return null;
  const s = p.selection?.permissionSelection;
  if (s && typeof s === 'object') return s.kind === 'agent-mode' ? ACCESS_ID[s.agentMode] ?? null : s.kind === 'custom' ? 'custom' : s.kind === 'profile' ? `profile:${s.profileId}` : s.kind === 'server-default' ? 'default' : null;
  if (typeof p.onClick !== 'function') return null;
  const ids = [...messageIds(p.children), ...messageIds(p.SubText)];
  for (const [prefix, id] of LEGACY_ID) if (ids.some((x) => x.startsWith(prefix))) return id;
  return el.key != null && !ids.length ? `profile:${el.key}` : null;
}
const isSelectedRow = (el) => {
  const p = el.props;
  if (p.selection && p.selectedPermissionSelection) return JSON.stringify(p.selection.permissionSelection) === JSON.stringify(p.selectedPermissionSelection);
  return p.RightIcon != null || p.rightIconAsset != null;
};
/** The menu element's rows rewritten (the first array of children holding access rows, a few levels down), or the element as it was. */
function rewriteRows(R, ctx, el, plan, depth = 0) {
  if (!el || typeof el !== 'object' || depth > 8 || !el.props) return el;
  const kids = el.props.children;
  if (Array.isArray(kids) && kids.some((k) => accessIdOf(k) != null)) {
    const Item = ctx.exports?.()?.MenuParts?.Item;
    const rows = applyChoices(kids, plan, {
      idOf: accessIdOf, keep: new Set(kids.filter((k) => accessIdOf(k) != null && isSelectedRow(k)).map(accessIdOf)),
      instanceOf: (k) => madeOf('AccessMode', accessIdOf(k)),
      relabel: (k, l) => (k.props.selection ? k : R.cloneElement(k, { ...(l.title ? { children: l.title } : {}), ...(l.description ? { SubText: l.description } : {}) })),
      make: (a) => (Item ? R.createElement(Item, { key: a.id, onClick: () => a.run?.(), ...(a.description ? { SubText: a.description } : {}) }, a.title) : null),
    });
    return R.cloneElement(el, null, ...rows);
  }
  if (kids && typeof kids === 'object' && !Array.isArray(kids)) { const next = rewriteRows(R, ctx, kids, plan, depth + 1); return next === kids ? el : R.cloneElement(el, null, next); }
  if (Array.isArray(kids)) {
    let changed = false;
    const next = kids.map((k) => { const n = rewriteRows(R, ctx, k, plan, depth + 1); if (n !== k) changed = true; return n; });
    return changed ? R.cloneElement(el, null, ...next) : el;
  }
  return el;
}
const containers = new WeakMap();   // the runtime's ctx -> place -> the access menu's container (one stable component each)
function accessContainer(ctx, place) {
  let byPlace = containers.get(ctx);
  if (!byPlace) containers.set(ctx, (byPlace = new Map()));
  let C = byPlace.get(place);
  if (!C) {
    C = function CodexmodsAccessChoices({ children }) {
      const plan = ctx.use(() => choicesPlan(ctx, 'access', place));
      const R = ctx.react();
      return plan && R ? rewriteRows(R, ctx, children, plan) : children ?? null;
    };
    byPlace.set(place, C);
  }
  return C;
}
export const accessMenu = defineBinding({
  id: 'access.dropdown', presentation: 'Composer', part: true, presents: ['Draft'], place: composerPlace,
  appParts: { access: 'self' },   // public-hooks.md §3.10: the access menu, hidden whole
  subject: (props, ctx, scope) => (props.conversationId == null ? draftOf(ctx, scope) : null),
  // its choices (ui.choices of access): the framework's container around the finished menu, while a mod declares some here
  render(Original, props, factory, ctx) {
    const place = props.conversationId == null ? 'newChat' : 'composer';
    if (props.DropdownContainer != null || !choicesPlan(ctx, 'access', place)) return undefined;
    return factory(Original, { ...props, DropdownContainer: accessContainer(ctx, place) });
  },
  operations: {
    async setAccess(props, [access], ctx) {
      if (props.conversationId != null || typeof props.onOpenChange !== 'function') return { unavailable: 'a chat\'s access is its Setting' };
      if (access === 'full') return { unavailable: 'full access is turned on by the user in the composer (the app asks first)' };
      const wanted = ACCESS[access];
      if (!wanted) return { unavailable: 'access is ask, approve or custom' };
      const mounts = (id) => (typeof ctx.mountsOf === 'function' ? ctx.mountsOf(id) : []).map((r) => r.props).filter(Boolean);
      // a row of this menu: the newer form names its host and folder (this dropdown's); the older form's items name only their message
      const ours = (p) => (typeof p.hostId !== 'string' || typeof props.hostId !== 'string' || p.hostId === props.hostId)
        && (props.cwdOverride == null || typeof p.cwd !== 'string' || p.cwd === props.cwdOverride);
      const legacy = (p, prefix) => typeof p.onClick === 'function' && [...messageIds(p.children), ...messageIds(p.SubText)].some((id) => id.startsWith(prefix));
      const anyOpen = () => mounts('access.row').some((p) => p.selection) || mounts('access.legacyRow').some((p) => Object.values(LEGACY).some((x) => legacy(p, x)));
      const find = () => {
        const row = mounts('access.row').find((p) => p.selection && p.selection.permissionSelection && ours(p) && wanted(p.selection.permissionSelection));
        if (row) return { disabled: row.selection.disabledReason ?? null, choose: () => row.selectPermission(row.selection.permissionSelection) };
        const item = mounts('access.legacyRow').find((p) => legacy(p, LEGACY[access]));
        return item ? { disabled: item.disabled === true ? 'disabled' : null, choose: () => item.onClick({ preventDefault() {}, stopPropagation() {} }) } : null;
      };
      // another permissions menu is open (another composer's): its rows could not be told from this one's (review 4)
      if (anyOpen()) return { unavailable: 'another permissions menu is open' };
      props.onOpenChange(true);
      let row = null;
      for (let waited = 0; waited <= ROW_WAIT_MS && !row; waited += ROW_EVERY_MS) {
        row = find();
        if (!row) await new Promise((r) => setTimeout(r, ROW_EVERY_MS));
      }
      if (!row) { props.onOpenChange(false); return { unavailable: 'the permissions menu does not offer it here' }; }
      if (row.disabled != null) { props.onOpenChange(false); return { unavailable: `the app has it turned off (${row.disabled})` }; }
      row.choose();
      props.onOpenChange(false);
      return true;
    },
  },
});
// a row of that menu (only while it is open; its newer form and its older one): read by `setAccess`
export const accessRow = defineBinding({ id: 'access.row', presents: ['Draft'], subject: () => null });
export const accessLegacyRow = defineBinding({ id: 'access.legacyRow', presents: ['Draft'], subject: () => null });
// The new chat's starting branch (E8.3g; scout E8-newchat-target §3): a new worktree's base, or a cloud chat's branch, in the bar's branch
// picker, which the bar shows only for those run locations; the picker holds the app's own setter, as its rows call it. The compact bar
// (21477) draws the picker in its options menu, only while that is open: the menu's `options` render it, and the setter is taken from that
// render. Read by the run location's `setBranch`, the picker or menu of the same composer (its scope), waited for after a change of the run
// location.
export const branchPicker = defineBinding({ id: 'branch.startingState', presents: ['Draft'], subject: () => null });
export const branchOptions = defineBinding({ id: 'branch.options', presents: ['Draft'], subject: () => null });
const PICKER_WAIT_MS = 1500;
/** The branch picker's setter of its starting state: `setStartingState` up to 22943, `onStartingStateChange` on 25679 (same value, `{type: 'branch', branchName}`). */
const startingSetter = (p) => (typeof p?.setStartingState === 'function' ? p.setStartingState : typeof p?.onStartingStateChange === 'function' ? p.onStartingStateChange : null);
/** The branch picker's props in an element the bar rendered (a few levels of fragments), or null. */
function pickerIn(v, depth = 0) {
  if (!v || typeof v !== 'object' || depth > 6) return null;
  if (Array.isArray(v)) { for (const x of v) { const p = pickerIn(x, depth + 1); if (p) return p; } return null; }
  const p = v.props;
  if (!p) return null;
  if (startingSetter(p) && (typeof p.branchSource === 'string' || (p.startingState && typeof p.hostConfig === 'object'))) return p;
  return pickerIn(p.children, depth + 1);
}
/**
 * The new chat's target as its composer shows it (E8.3h): where it runs, its starting branch and its mode from the composer's parts, its
 * model and effort from its model menu; null when no new chat's composer is mounted. Sent with the window's reports, read into the Draft.
 */
export function newChatTargetOf(ctx) {
  const all = (id) => (typeof ctx.mountsOf === 'function' ? ctx.mountsOf(id) : []).filter((m) => m.props && m.scope && m.scope.kind === 'new' && newKey(m.scope) === 'new-conversation');
  // one composer's reading, all its fields together: with a second composer of the new chat here (a page kept mounted out of sight),
  // which one shows the target is not known, and nothing is said (graph-layers.md §5); with one, every part mounted is its own (a part
  // may be drawn more than once in it: its first says what it shows)
  if (all('composer').length > 1) return null;
  const [run = null] = all('composer.runLocation'), [collab = null] = all('composer.mode'), [menu = null] = all('picker.model');
  if (!run && !collab && !menu) return null;
  const out = {};
  const env = run?.props.composerMode;
  if (env === 'local' || env === 'worktree' || env === 'cloud') out.environment = env;
  const start = run?.props.asyncThreadStartingState;
  if ((env === 'worktree' || env === 'cloud') && start && start.type === 'branch' && typeof start.branchName === 'string' && start.branchName) out.branch = start.branchName;
  if (collab) { const a = collab.props.activeCollaborationMode; out.mode = (typeof a === 'string' ? a : a?.mode) === 'plan' ? 'plan' : 'default'; }
  if (menu && typeof menu.props.model === 'string' && menu.props.model) out.model = menu.props.model;
  if (menu && typeof menu.props.reasoningEffort === 'string' && menu.props.reasoningEffort) out.effort = menu.props.reasoningEffort;
  return out;
}
export const composerRunLocation = defineBinding({
  id: 'composer.runLocation', presentation: 'Composer', part: true, presents: ['Draft'], place: composerPlace,
  appParts: { runLocation: 'self' },   // public-hooks.md §3.10: where a new chat runs, hidden whole
  subject: (props, ctx, scope) => draftOf(ctx, scope),
  windowFacts: (ctx) => ({ newChat: newChatTargetOf(ctx) }),   // null once no new chat's composer is mounted: told too
  operations: {
    setMode(props, [mode]) {
      if (typeof props.setComposerMode !== 'function' || !['local', 'worktree', 'cloud'].includes(mode)) return false;
      props.setComposerMode(mode);
      return true;
    },
    async setBranch(props, [name], ctx, rec) {
      if (typeof name !== 'string' || !name) return { unavailable: 'a branch is named' };
      // the same composer: its own scope first, else the Draft its scope names (each component reads its own copy of the scope's value);
      // two composers of one Draft here (a hidden one kept mounted) are not told apart: refused (review 4)
      const want = rec ? draftOf(ctx, rec.scope)?.id ?? null : null;
      const same = (m) => !rec || m.scope === rec.scope || (want != null && draftOf(ctx, m.scope)?.id === want);
      const mine = (id) => (typeof ctx.mountsOf === 'function' ? ctx.mountsOf(id) : []).filter((m) => m.props && same(m));
      let failed = null;
      const picker = () => {
        const shown = mine('branch.startingState').filter((m) => startingSetter(m.props));
        if (shown.length > 1) return { twice: true };
        if (shown.length) return shown[0].props;
        const menus = mine('branch.options').filter((m) => typeof m.props.options === 'function');
        if (menus.length > 1) return { twice: true };
        for (const m of menus) {
          try { const p = pickerIn(m.props.options(undefined)); if (p) return p; } catch (e) { failed = String(e?.message ?? e); }
        }
        return null;
      };
      let p = picker();
      for (let waited = 0; !p && waited < PICKER_WAIT_MS; waited += ROW_EVERY_MS) {
        await new Promise((r) => setTimeout(r, ROW_EVERY_MS));
        p = picker();
      }
      if (p?.twice) return { unavailable: 'two composers of this draft are shown: which one is not known' };
      if (!p && failed) return { unavailable: `the composer's options could not be read (${failed.slice(0, 120)})` };
      if (!p) return { unavailable: 'this new chat runs locally, on the project\'s checked-out branch: a new worktree or a cloud chat starts from a branch' };
      startingSetter(p)({ type: 'branch', branchName: name });
      return true;
    },
  },
});
