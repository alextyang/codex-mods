// One send's settings (docs/design/public-hooks.md §3.4, H5; scout H5-data §5) and why a turn started (Turn.trigger, §6). Pure.
// - `Thread.send(content, {settings: {model?, effort?, mode?, access?}, sticky?})`: the thread's own Setting keys and values, as
//   `turn/start` overrides. The protocol keeps an override for later turns too, so a send's settings are put back after its turn
//   starts (`thread/settings/update` with the thread's values before), unless `sticky`. Access may only narrow, to read-only, and only on
//   a chat whose access is a sandbox mode (a named permissions profile cannot be put back this way): full access is the user's.
// - A turn's trigger, from the `turn/start` that started it: the app's own `turnTrigger` (composer, queue, retry, edit, automation, ...)
//   or the client that sent it (a mod through the graph); a turn no client started (a goal's continuation) says so where it can.

export const SEND_KEYS = Object.freeze(['model', 'effort', 'mode', 'access']);
const ACCESS_SANDBOX = { 'read-only': { type: 'readOnly' }, workspace: { type: 'workspaceWrite' }, full: { type: 'dangerFullAccess' } };
const refuse = (reason, message) => ({ refused: { status: 'refused', reason, message } });

/**
 * The `turn/start` overrides for a send's settings, given the thread's current values (`current`: {model, effort, mode, access}, its
 * Settings') and the models this provider offers (`models`: [{id, efforts: [id]}]). `{params, changed}` or `{refused}`.
 */
export function sendParams(settings, { current = {}, models = [] } = {}) {
  if (settings === undefined || settings === null) return { params: {}, changed: [] };
  if (typeof settings !== 'object' || Array.isArray(settings)) return refuse('invalid', 'settings is {model?, effort?, mode?, access?}');
  const unknown = Object.keys(settings).filter((k) => !SEND_KEYS.includes(k));
  if (unknown.length) return refuse('invalid', `a send takes the settings ${SEND_KEYS.join(', ')} (not ${unknown.join(', ')})`);
  const params = {}, changed = [];
  const model = settings.model ?? current.model ?? null;
  if (settings.model !== undefined) {
    if (!models.some((m) => m.id === settings.model)) return refuse('invalid', `no model ${settings.model} is offered here`);
    params.model = settings.model; changed.push('model');
  }
  const effort = settings.effort ?? (settings.model !== undefined ? null : current.effort ?? null);
  if (settings.effort !== undefined) {
    const efforts = models.find((m) => m.id === model)?.efforts ?? [];
    if (efforts.length && !efforts.includes(settings.effort)) return refuse('invalid', `${model} takes the efforts ${efforts.join(', ')}`);
    params.effort = settings.effort; changed.push('effort');
  }
  if (settings.mode !== undefined) {
    if (settings.mode !== 'default' && settings.mode !== 'plan') return refuse('invalid', 'mode is default or plan');
    params.collaborationMode = { mode: settings.mode, settings: { model, reasoning_effort: effort, developer_instructions: null } };
    changed.push('mode');
  }
  if (settings.access !== undefined) {
    if (settings.access !== 'read-only') return refuse('notAllowed', 'a send may only narrow access, to read-only (full access is the user\'s)');
    if (!ACCESS_SANDBOX[current.access]) return refuse('unsupported', 'this chat\'s access is a permissions profile: one send cannot narrow it');
    if (current.access !== 'read-only') { params.sandboxPolicy = ACCESS_SANDBOX['read-only']; changed.push('access'); }
  }
  return { params, changed };
}

/** The `thread/settings/update` that puts the thread's values back for the keys a send changed (null: nothing to put back). */
export function restoreParams(threadId, changed, current = {}) {
  const out = { threadId };
  if (changed.includes('model') && current.model) out.model = current.model;
  if ((changed.includes('effort') || changed.includes('model')) && current.effort) out.effort = current.effort;
  if (changed.includes('mode') && (current.mode === 'default' || current.mode === 'plan')) {
    out.collaborationMode = { mode: current.mode, settings: { model: current.model ?? null, reasoning_effort: current.effort ?? null, developer_instructions: null } };
  }
  if (changed.includes('access') && ACCESS_SANDBOX[current.access]) out.sandboxPolicy = ACCESS_SANDBOX[current.access];
  return Object.keys(out).length > 1 ? out : null;
}

/** The app's `turnTrigger` values (21477) and the trigger each is; any other value from the app is `app`, its value kept as detail. */
const APP_TRIGGERS = [
  [/^composer$/, 'composer'], [/^composer_queue/, 'queue'], [/^queued_/, 'queue'], [/retry|^resume_interrupted_task$/, 'retry'],
  [/^edit_user_message$/, 'edit'], [/^automation_/, 'automation'], [/^code_review$/, 'review'], [/^notification_reply$/, 'reply'],
  [/handoff$/, 'handoff'],
];
/**
 * Why a turn started: `{trigger, triggerBy?, triggerDetail?}` from the `turn/start` that started it (its `turnTrigger` and the client it
 * came on; `by` when this provider sent it for a graph caller). Only the app's own connection's `turnTrigger` is taken: a mod's own client's
 * turn is the mod's and any other client's (a lease) not known, whatever `turnTrigger` it gave (it would pass for an automation's).
 */
export function triggerOf(raw, origin, by = null) {
  if (by && by.kind === 'mod') return { trigger: 'mod', triggerBy: by.id };
  if (typeof origin === 'string' && origin.startsWith('mod:')) return { trigger: 'mod', triggerBy: origin.slice(4) };
  if (origin === 'app') {
    if (raw === null || raw === undefined || raw === '') return { trigger: 'composer' };
    for (const [re, trigger] of APP_TRIGGERS) if (re.test(raw)) return { trigger, ...(trigger === 'composer' ? {} : { triggerDetail: raw }) };
    return { trigger: 'app', triggerDetail: String(raw) };
  }
  return { trigger: 'unknown' };
}
