// ComposerPicker (docs/graph/03): the app's own pickers in a chat's composer (E7.2, "E7 in detail" decision 8). On 21477 the model menu
// is the component whose props carry the models, onSelectModel and onOpenChange (its menu's open state, the app's own setter); its props
// say nothing of the chat, so the address reads ComposerScope: a chat's main composer's model menu presents that chat's `model` Setting
// (thread:<id>:model, as the native provider serves it), under its Composer. Opening it is the app's own `onOpenChange(true)` (what the
// window shows); choosing is the Setting's own `set` (the windows provider's route). The framework's own pickers (E3) are its own
// presentations, which take no act. It passes through. The new chat's model menu (E8.3c, the home composer's: ComposerScope `new`, the
// app's `new-conversation` draft) presents that Draft's model, a draft-scope Setting (`new:app:new-conversation:model`), under the new
// chat's Composer; `choose(model | null, effort?)` is the menu's own `onSelectModel` (the app keeps the choice for the chat it starts), checked
// against the models and efforts the menu offers. NO NODE API.
import { defineBinding } from '../runtime.mjs';
import { newKey } from './composer.mjs';
import { choicesPlan, applyChoices, memoOne, madeOf } from '../choices.mjs';
import { siblingList, besideOnce, badgeNode, withoutSiblings } from './slots.mjs';

// ui.choices (public-hooks.md §3.11; scout H4-choices §2.1): the menu offers the models of its rows (`modelOptions`, by slug) and the stops of
// its slider (`powerSelections`, a model's efforts); a mod hides, orders and relabels models and efforts, and adds an entry whose choice runs
// its callback (the app's own choice is vetoed before it runs). The selected model and stop always stay; the slider keeps at least two
// stops (with fewer the app turns it into its list), and its stops keep their order (it is the power scale). Results are cached on the
// lists they come from, so the menu's own caches see the same arrays while nothing changed.
const memos = new WeakMap();   // the app's modelOptions array -> place -> its cached rewrite
const placeOf = (scope) => (scope && scope.kind === 'new' ? 'newChat' : 'composer');
// A model option: this Mac's Model where the menu lists this Mac's catalog (its host, from the pack's identity props: H7z) and the graph has
// it; else as it shows itself (its slug, name and description): a remote host's model of the same slug is not this Mac's Model, so a choice
// reads the option, never the local Model's state or data (built review H7s round 2).
const localModel = (ctx, slug) => { const x = ctx.subject?.({ type: 'Model', provider: 'codex', id: slug }); return x && !x.gone && x.state ? x : null; };
const modelOf = (option, ctx, hostId) => {
  const m = option && typeof option === 'object' ? option.model ?? option : null;
  const slug = m && typeof m.model === 'string' ? m.model : null;
  if (!slug) return null;
  return (hostId === 'local' ? localModel(ctx, slug) : null)
    ?? madeOf('Model', slug, { ...(typeof m.displayName === 'string' ? { title: m.displayName } : {}), ...(typeof m.description === 'string' ? { description: m.description } : {}) });
};
function chosen(props, ctx, mp, ep) {
  const instanceOf = (o) => modelOf(o, ctx, props.hostId);
  const keepModels = new Set([props.model, props.lockedModelSlug].filter((x) => typeof x === 'string'));
  const stops = Array.isArray(props.powerSelections) ? props.powerSelections : null;
  const selected = stops?.find((x) => x && x.model === props.model && x.reasoningEffort === props.reasoningEffort)?.id;
  const keepStops = new Set(selected ? [selected] : []);
  let { modelOptions, models, onBeforeSelectModel } = props;
  let powerSelections = stops;
  if (mp) {
    modelOptions = applyChoices(props.modelOptions, mp, {
      idOf: (o) => o?.model?.model ?? null, instanceOf, keep: keepModels,
      relabel: (o, l) => ({ ...o, model: { ...o.model, ...(l.title ? { displayName: l.title } : {}), ...(l.description ? { description: l.description } : {}) } }),
      make: (a) => ({ model: { model: a.id, displayName: a.title, description: a.description ?? '', supportedReasoningEfforts: [], defaultReasoningEffort: null }, disabledReason: null }),
    });
    // the slider follows the rows: a hidden model's stops go, a relabelled model's stops say its name
    const hidden = new Set((props.modelOptions ?? []).filter((o) => typeof o?.model?.model === 'string' && !keepModels.has(o.model.model) && mp.hides(o.model.model, instanceOf(o))).map((o) => o.model.model));
    powerSelections = stops && stops.filter((x) => keepStops.has(x.id) || !hidden.has(x.model)).map((x) => { const l = mp.labelOf(x.model); return l?.title ? { ...x, modelLabel: l.title } : x; });
    models = Array.isArray(props.models) ? props.models.map((m) => { const l = mp.labelOf(m?.model); return l ? { ...m, ...(l.title ? { displayName: l.title } : {}), ...(l.description ? { description: l.description } : {}) } : m; }) : props.models;
    const added = new Map(mp.adds.map((a) => [a.id, a]));
    if (added.size) {
      const own = props.onBeforeSelectModel;
      onBeforeSelectModel = (slug, ...rest) => {
        const a = added.get(slug);
        if (!a) return typeof own === 'function' ? own(slug, ...rest) : undefined;
        try { a.run?.(); } finally { props.onOpenChange?.(false); }
        return false;   // never the app's choice
      };
    }
  }
  if (ep && powerSelections) {
    const kept = powerSelections.filter((x) => keepStops.has(x.id) || !ep.hides(x.reasoningEffort, madeOf('Effort', x.reasoningEffort)));
    const next = kept.length >= 2 || powerSelections.length < 2 ? kept : powerSelections;
    powerSelections = next.map((x) => { const l = ep.labelOf(x.reasoningEffort); return l?.title ? { ...x, sliderLabel: `${x.modelLabel ?? ''} ${l.title}`.trim() } : x; });
  }
  return { ...props, modelOptions, powerSelections, models, onBeforeSelectModel };
}

const chatThread = (scope) => (scope && scope.kind === 'local' && scope.placement === 'main' && typeof scope.conversationId === 'string' && scope.conversationId ? scope.conversationId : null);
const NEW = 'new:app:new-conversation';
const newChat = (scope) => (scope && scope.kind === 'new' && newKey(scope) === 'new-conversation');
/** The new chat's draft-scope Setting the menu presents (its model). */
export const NEW_MODEL = Object.freeze({ type: 'Setting', provider: 'codex', id: `${NEW}:model` });

export const modelPicker = defineBinding({
  id: 'picker.model', presentation: 'ComposerPicker',
  presents: ['Setting'],
  // the Composer's `model` part (public-hooks.md §3.10): the menu, not drawn
  appParts: { model: 'self' }, appPartsOf: 'Composer',
  place: (props, scope) => {
    const id = chatThread(scope) ?? (newChat(scope) ? NEW : null);
    return id ? { in: 'Composer', on: { type: 'Draft', provider: 'codex', id }, slot: 'pickers' } : { in: null, slot: 'pickers' };
  },
  subject(props, ctx, scope) {
    if (newChat(scope)) return NEW_MODEL;
    const id = chatThread(scope);
    const thread = id ? ctx.thread(id) : null;
    // eslint-disable-next-line codexmods/no-provider-identity -- the app's own model setting of its chat
    return thread && thread.provider === 'codex' ? { type: 'Setting', provider: 'codex', id: `thread:${thread.id}:model` } : null;
  },
  render(Original, props, factory, ctx, scope) {
    const place = placeOf(scope);
    const mp = choicesPlan(ctx, 'Model', place), ep = choicesPlan(ctx, 'effort', place);
    if (!mp && !ep || !Array.isArray(props.modelOptions)) return undefined;
    let byPlace = memos.get(props.modelOptions);
    if (!byPlace) memos.set(props.modelOptions, (byPlace = new Map()));
    let memo = byPlace.get(place);
    if (!memo) byPlace.set(place, (memo = memoOne()));
    // a plan that reads the models as instances: which it hides now, worked out on every render (what a where or a function reads, the
    // Models, what they relate to and the data attached, as their mods see it, is read each time, so a change of any is seen: H7z review 2)
    const seen = mp?.reads ? props.modelOptions.map((o) => { const slug = o?.model?.model; return typeof slug === 'string' && mp.hides(slug, modelOf(o, ctx, props.hostId)) ? slug : ''; }).join('|') : '';
    const out = memo([props.powerSelections, props.models, props.model, props.reasoningEffort, props.lockedModelSlug, props.onBeforeSelectModel, props.onOpenChange, props.hostId, mp?.sig, ep?.sig, seen],
      () => chosen(props, ctx, mp, ep));
    return factory(Original, out === props ? props : { ...props, modelOptions: out.modelOptions, powerSelections: out.powerSelections, models: out.models, onBeforeSelectModel: out.onBeforeSelectModel });
  },
  operations: {
    open(props) {
      if (typeof props.onOpenChange !== 'function') return { unavailable: 'this picker cannot be opened from here' };
      props.onOpenChange(true);
      return true;
    },
    /** The new chat's model (and effort): the menu's own choice, among what it offers. */
    choose(props, [model, effort], ctx, rec) {
      if (!newChat(rec?.scope) || typeof props.onSelectModel !== 'function' || !Array.isArray(props.models)) return { unavailable: 'this menu chooses a chat\'s model through its Setting' };
      const slug = model ?? props.model;   // an effort alone: the chosen model's
      const m = props.models.find((x) => x && x.model === slug);
      if (!m) return { unavailable: `the menu does not offer ${String(slug)}` };
      const efforts = Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts.map((x) => x?.reasoningEffort).filter(Boolean) : [];
      if (effort != null && !efforts.includes(effort)) return { unavailable: `${slug} takes the efforts ${efforts.join(', ') || 'none'}` };
      props.onSelectModel(slug, effort ?? (efforts.includes(props.reasoningEffort) ? props.reasoningEffort : undefined));
      return true;
    },
  },
});

// A model's row in the composer's model menu (21477: the label each row draws, `{pickerRow, model, displayName, stripGptPrefix}`, the row
// marked by the pack's identity props; the menu's other labels, its trigger's and its slider's, carry the same props without it): under the
// menu (its nearest site, which names the host whose catalog it lists), a ListItem of this Mac's Model of that slug, the mods' badges after
// its name (public-hooks.md §3.13, H7z). Another host's row names nothing.
export const modelRow = defineBinding({
  id: 'model.row', presentation: 'ListItem', presents: ['Model'], subjectOnly: true,   // the menu's trigger and slider labels are no ListItem
  place: { in: 'Window', slot: 'models' },
  subject: (props, ctx, scope, near) => (props.pickerRow === true && typeof props.model === 'string' && props.model && near?.binding === 'picker.model' && near.props?.hostId === 'local'
    ? { type: 'Model', provider: 'codex', id: props.model } : null),
  slots: { badges: siblingList(({ R, ctx }, item, key) => badgeNode(R, ctx, item, key), { field: 'badges' }) },
  // a label (a leaf) with no badges is the app's own, untouched
  render(Original, props, factory, ctx) {
    const R = ctx.react();
    return R && withoutSiblings(props)[1].length ? besideOnce(R, 'model.row', factory, Original, props) : undefined;
  },
});
