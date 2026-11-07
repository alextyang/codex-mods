// The app's own new-automation form filled with the mods' automation defaults (public-hooks.md §3.8, H6j; bindings/automation-form.mjs):
// set once into its untouched draft through the page's own setDraft, a project once the form has it; never over what the user, a template
// or a seed put there; never a name or where it runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeReact } from './fake-react.mjs';
import { automationForm, untouched, withValues } from '../present/bindings/automation-form.mjs';

// 21477's empty draft (`hv`), the model the form fills as it draws left out
const EMPTY = Object.freeze({ cloudTeam: null, id: null, kind: 'heartbeat', name: '', prompt: '', status: 'ACTIVE', projectId: null, cwds: ['~'], executionEnvironment: 'local',
  localEnvironmentConfigPath: null, pluginTemplateId: null, targetThreadId: null, model: null, reasoningEffort: null, rawRrule: null, scheduleConfig: { mode: 'daily' }, scheduleDirty: false });
const flush = () => new Promise((r) => setTimeout(r, 0));

/** The page: its draft in its own state, the form bound; `setDraft` takes a value or an updater, as the app's does. */
function page({ draft = EMPTY, projects = [], values = {} } = {}) {
  const { React, ReactDOM } = createFakeReact();
  let set = null, seen = null, asked = 0, shownProjects = projects;
  const Form = (p) => { seen = p; return null; };
  const ctx = { react: () => React, automationDefaults: async () => { asked++; return values; } };
  const factory = (type, props) => React.createElement(type, props);
  const Page = () => {
    const [d, setD] = React.useState(draft);
    set = setD;
    const props = { draft: d, setDraft: (u) => setD((x) => (typeof u === 'function' ? u(x) : u)), initialDraft: EMPTY, scheduleSelection: {}, resolvedProjects: shownProjects };
    return automationForm.render(Form, props, factory, ctx) ?? factory(Form, props);
  };
  const root = ReactDOM.createRoot({});
  const draw = () => root.render(React.createElement(Page, {}));
  draw();
  return { draft: () => seen.draft, asked: () => asked, type: (fn) => set(fn), user: (u) => seen.setDraft(u), setProjects(p) { shownProjects = p; draw(); }, draw };
}

test('H6j: an untouched form takes the defaults once: status, notifications, model and effort together, archiving; never a name or where it runs', async () => {
  const p = page({ values: { enabled: false, notifications: 'failures', settings: { model: 'gpt-6-luna', effort: 'low' }, archiveRuns: true, name: 'Nightly', where: 'worktree' } });
  await flush(); await flush();
  const d = p.draft();
  assert.deepEqual([d.status, d.notificationPolicy, d.model, d.reasoningEffort, d.autoArchive], ['PAUSED', 'failed_runs_only', 'gpt-6-luna', 'low', true]);
  assert.deepEqual([d.name, d.executionEnvironment, d.kind], ['', 'local', 'heartbeat'], 'no name (the app would ask before Cancel), its own run location and kind');
  // the user changes what was set (through the form): theirs, never set again
  p.user((x) => ({ ...x, status: 'ACTIVE' }));
  p.draw(); await flush();
  assert.equal(p.draft().status, 'ACTIVE');
  assert.equal(p.asked(), 1);
});

test('H6j: a project default makes it a run in a new chat in that project, once the form has the project', async () => {
  const project = { projectId: 'p1', projectKind: 'local', rootPaths: ['/r/one'] };   // 21477's shape
  const p = page({ values: { project: { type: 'LocalProject', provider: 'codex', id: 'p1' } } });
  await flush(); await flush();
  assert.deepEqual([p.draft().kind, p.draft().projectId], ['heartbeat', null], 'not among the form\'s projects yet');
  p.setProjects([project]);
  await flush();
  const d = p.draft();
  assert.deepEqual([d.kind, d.projectId, d.cwds, d.scheduleDirty], ['cron', 'p1', ['/r/one'], true]);
});

test('H6j: a form that is not untouched (a template\'s, a seed\'s, the user\'s) is left as it is, and nothing is asked', async () => {
  for (const draft of [{ ...EMPTY, name: 'From a plugin', prompt: 'Do it', pluginTemplateId: 'tpl' }, { ...EMPTY, id: 'a1' }, { ...EMPTY, scheduleDirty: true }]) {
    const p = page({ draft, values: { enabled: false } });
    await flush(); await flush();
    assert.deepEqual(p.draft(), draft);
    assert.equal(p.asked(), 0);
  }
  assert.equal(untouched(EMPTY), true);
  assert.equal(untouched({ ...EMPTY, model: 'm' }), true, 'the model the form fills as it draws');
});

test('H6j: an effort alone keeps the model the form shows; none shown yet, neither is set (the app chooses both)', () => {
  assert.deepEqual(withValues({ ...EMPTY, model: 'm1', reasoningEffort: 'medium' }, { settings: { effort: 'high' } }, null), { ...EMPTY, model: 'm1', reasoningEffort: 'high' });
  assert.equal(withValues(EMPTY, { settings: { effort: 'high' } }, null), null);
  assert.equal(withValues(EMPTY, { notifications: 'all' }, null), null, '"all" is the form\'s own');
});

test('H6j review round 1: once the user writes through the form, nothing more is set: not the answer still coming, not a project still waiting', async () => {
  let answer;
  const late = new Promise((r) => { answer = r; });
  const { React, ReactDOM } = createFakeReact();
  let seen = null;
  const Form = (p) => { seen = p; return null; };
  const ctx = { react: () => React, automationDefaults: () => late };
  const Page = () => {
    const [d, setD] = React.useState(EMPTY);
    const props = { draft: d, setDraft: (u) => setD((x) => (typeof u === 'function' ? u(x) : u)), initialDraft: EMPTY, scheduleSelection: {}, resolvedProjects: [] };
    return automationForm.render(Form, props, (t, pr) => React.createElement(t, pr), ctx);
  };
  ReactDOM.createRoot({}).render(React.createElement(Page, {}));
  await flush();
  seen.setDraft((x) => ({ ...x, model: 'their-model', reasoningEffort: 'high' }));   // the user's choice while the defaults are asked for
  answer({ settings: { model: 'mod-model', effort: 'low' }, enabled: false });
  await flush(); await flush();
  assert.deepEqual([seen.draft.model, seen.draft.reasoningEffort, seen.draft.status], ['their-model', 'high', 'ACTIVE']);
  // a project waiting for the form's projects: the user's run choice meanwhile keeps it out
  const p = page({ values: { project: { type: 'LocalProject', provider: 'codex', id: 'p1' } } });
  await flush(); await flush();
  p.user((x) => ({ ...x, kind: 'heartbeat', scheduleDirty: true }));
  p.setProjects([{ projectId: 'p1', projectKind: 'local', rootPaths: ['/r'] }]);
  await flush();
  assert.deepEqual([p.draft().kind, p.draft().projectId], ['heartbeat', null]);
});

test('H6j review round 1: an effort alone waits for the model the form shows, then is set once', async () => {
  const p = page({ values: { settings: { effort: 'high' } } });
  await flush(); await flush();
  assert.equal(p.draft().reasoningEffort, null, 'no model shown yet');
  p.type((x) => ({ ...x, model: 'app-model', reasoningEffort: 'medium' }));   // the app's own choice, as its models load
  p.draw(); await flush();
  assert.deepEqual([p.draft().model, p.draft().reasoningEffort], ['app-model', 'high']);
});

test('H6j review round 2: a write of the form\'s that changes nothing (its former prompt editor\'s, on every transaction) is no edit', async () => {
  const p = page({ values: { settings: { effort: 'high' }, project: { type: 'LocalProject', provider: 'codex', id: 'p1' } } });
  await flush(); await flush();
  p.user((t) => (t.prompt === '' ? t : { ...t, prompt: '' }));   // the editor's own write: the same draft back
  p.type((x) => ({ ...x, model: 'app-model', reasoningEffort: 'medium' }));
  p.setProjects([{ projectId: 'p1', projectKind: 'local', rootPaths: ['/r'] }]);
  await flush(); await flush();
  assert.deepEqual([p.draft().reasoningEffort, p.draft().projectId, p.draft().kind], ['high', 'p1', 'cron'], 'what waited is still set');
});
