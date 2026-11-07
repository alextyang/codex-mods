// The app's own "new automation" form (docs/design/public-hooks.md §3.8, H6j; scout H6j-form): what the mods' defaults give a new
// automation is set into the form's draft once, as the user opens it and before they change anything, so they see it and may change it
// (the user's choice, then the mods' defaults, then the app's). On 21477 the form (create only, the Scheduled page's and its create
// dialog's, in both layouts) holds no state of its own: its `draft` and `setDraft` are the page's, which nothing writes after it mounts but
// the user, so one `setDraft` holds, and the form's own writes that change the draft are the user's: once the user writes, nothing more
// is set. Set: `enabled` (its status), `notifications`, `settings` (model and effort together: the app fills
// both from its own choice while the model is unset), `archiveRuns`, and `project` (a run in a new chat each time, as the app's own kind
// switch makes it; once the project is among the form's, which may resolve late). Not set: `name` (a named draft makes the app ask before
// its Cancel and skip its own title from the prompt) and `where` (the app's create runs every new automation locally). NO NODE API.
import { defineBinding } from '../runtime.mjs';

/** Untouched: the app's own empty draft (21477 `gBt`, less the model the form fills as it draws): no template, seed or edit in it. */
export function untouched(d) {
  return !!d && typeof d === 'object' && d.id == null && d.cloudTeam == null && d.name === '' && d.prompt === '' && d.projectId == null
    && d.pluginTemplateId == null && d.targetThreadId == null && d.notificationPolicy == null && !d.autoArchive && d.rawRrule == null
    && d.scheduleDirty === false && d.status === 'ACTIVE';
}
/** A local project of the form's (21477: `{projectId, projectKind, rootPaths}`), by the id of the project a default names. */
// eslint-disable-next-line codexmods/no-provider-identity -- the app's own projects
const projectIn = (projects, ref) => (Array.isArray(projects) && ref && ref.provider === 'codex' && typeof ref.id === 'string'
  ? projects.find((p) => p && p.projectId === ref.id && (p.projectKind === undefined || p.projectKind === 'local')) ?? null : null);
const rootsOf = (p) => (Array.isArray(p.rootPaths) && p.rootPaths.length ? p.rootPaths : typeof p.path === 'string' ? [p.path] : []);

/**
 * The draft with the defaults' `values` set (null: nothing to set). `project`: the form's project the default names, or null (not among
 * them yet: set later, by itself).
 */
export function withValues(d, values, project) {
  const next = { ...d };
  let changed = false;
  const put = (k, v) => { if (next[k] !== v) { next[k] = v; changed = true; } };
  if (typeof values.enabled === 'boolean') put('status', values.enabled ? 'ACTIVE' : 'PAUSED');
  if (values.notifications === 'failures') put('notificationPolicy', 'failed_runs_only');
  const s = values.settings && typeof values.settings === 'object' ? values.settings : null;
  if (s) {
    // together: an effort alone keeps the model the form shows (none shown yet: not set, the app would choose both)
    const model = typeof s.model === 'string' ? s.model : d.model;
    if (typeof model === 'string' && model) {
      put('model', model);
      put('reasoningEffort', typeof s.effort === 'string' ? s.effort : typeof s.model === 'string' ? null : d.reasoningEffort ?? null);
    }
  }
  if (typeof values.archiveRuns === 'boolean') put('autoArchive', values.archiveRuns);
  if (project) Object.assign(next, inProject(next, project)), changed = true;
  return changed ? next : null;
}
/** The draft as a run in a new chat each time in that project (21477 `yBt` then the project picker's `vBt`). */
function inProject(d, project) {
  const roots = rootsOf(project);
  return { kind: 'cron', cwds: roots.length ? roots : Array.isArray(d.cwds) && d.cwds.length ? d.cwds : ['~'], executionEnvironment: d.executionEnvironment ?? 'local',
    rawRrule: null, scheduleDirty: true, cadenceSelected: d.cadenceSelected ?? (d.scheduleDirty || !!d.rawRrule), projectId: project.projectId };
}

/**
 * The form with its defaults: the form's own `setDraft` given to it marks the user's writes (any write of the form's is the user's: the
 * page's draft has no other writer once it mounts), and once the user has written nothing more is set, even what still waits (a project
 * the form does not have yet, model and effort before the form shows a model). Asked once per form; set once; what waits, once it can.
 */
function Filled({ Original, form, factory, ctx }) {
  const R = ctx.react();
  const ref = R.useRef(null);
  if (!ref.current) {
    const st = { asked: false, set: false, edited: false, settings: null, project: null, form };
    // a write that changes nothing is not an edit (21477's former prompt editor writes on every transaction of its editor, the same
    // draft back when its text did not change)
    st.setDraft = (u) => {
      const cur = st.form.draft;
      let next = u;
      if (typeof u === 'function') { try { next = u(cur); } catch { next = undefined; } }
      if (next !== cur) { st.edited = true; st.settings = null; st.project = null; }
      return st.form.setDraft(u);
    };
    ref.current = st;
  }
  const st = ref.current;
  st.form = form;
  const [values, setValues] = R.useState(null);
  R.useEffect(() => {
    if (st.asked) return;
    st.asked = true;
    if (!untouched(form.draft) || typeof ctx.automationDefaults !== 'function') return;   // a template's, a seed's, or the user's own
    Promise.resolve(ctx.automationDefaults()).then((v) => { if (v && typeof v === 'object' && Object.keys(v).length) setValues(v); }, () => {});
  }, []);
  R.useLayoutEffect(() => {
    if (!values || st.edited) return;
    const d = form.draft;
    if (!st.set) {
      st.set = true;
      if (!untouched(d)) return;
      const project = values.project ? projectIn(form.resolvedProjects, values.project) : null;
      st.project = values.project && !project ? values.project : null;   // set once the form has it
      // model and effort together: before the form shows a model, they wait for one (the app chooses both meanwhile)
      const s = values.settings && typeof values.settings === 'object' ? values.settings : null;
      st.settings = s && typeof s.model !== 'string' && !(typeof d.model === 'string' && d.model) ? s : null;
      // one updater (the page's setDraft keeps only the last of two in one tick), over the draft as the page has it then
      form.setDraft((x) => withValues(x, values, project) ?? x);
      return;
    }
    if (st.settings && typeof d.model === 'string' && d.model) {
      const s = st.settings;
      st.settings = null;
      form.setDraft((x) => withValues(x, { settings: s }, null) ?? x);
      return;
    }
    if (st.project) {
      const project = projectIn(form.resolvedProjects, st.project);
      if (!project) return;
      st.project = null;
      form.setDraft((x) => (x.projectId == null && x.kind !== 'cron' && x.prompt === '' && x.scheduleDirty === false ? { ...x, ...inProject(x, project) } : x));
    }
  });
  return factory(Original, { ...form, setDraft: st.setDraft });
}

export const automationForm = defineBinding({
  id: 'automation.form',
  presents: ['Automation'],
  render(Original, props, factory, ctx) {
    const R = ctx.react();
    if (!R || typeof props.setDraft !== 'function') return undefined;
    // the same tree on every render (the form is never mounted again): the form, inside what sets its defaults
    return R.createElement(Filled, { Original, form: props, factory, ctx });
  },
});
