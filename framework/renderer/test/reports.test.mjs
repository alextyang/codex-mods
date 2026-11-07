// The framework's own presentations (docs/design/systems.md E6 decision 6, E6.5): a component reports one while it is mounted, through
// the runtime's reporter, with framework-only bindings that no rule targets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeReact } from './fake-react.mjs';
import { createReport, FRAMEWORK_BINDINGS, REPORTED } from '../present/reports.mjs';

const MOD = { type: 'Mod', provider: 'codexmods.framework', id: 'acme.demo', extra: 'dropped' };

test('Report puts a record while mounted, puts another when its subject or place changes, removes it when it goes', () => {
  const { React, ReactDOM } = createFakeReact();
  const log = [];
  const ctx = { report: { put: (rec) => log.push(['put', rec]), remove: (rec) => log.push(['remove', rec]) } };
  const Report = createReport(React, ctx);
  const root = ReactDOM.createRoot({});
  root.render(React.createElement(Report, { type: 'Dialog', subject: MOD, place: { in: 'Window', slot: 'consent' } }));
  assert.deepEqual(log.map(([k, r]) => [k, r.binding, r.props]), [['put', 'framework:Dialog', { subject: { type: 'Mod', provider: 'codexmods.framework', id: 'acme.demo' }, place: { in: 'Window', slot: 'consent' } }]]);
  root.render(React.createElement(Report, { type: 'Dialog', subject: MOD, place: { in: 'Window', slot: 'consent' } }));
  assert.equal(log.length, 1, 'the same presentation: nothing again');
  root.render(React.createElement(Report, { type: 'Dialog', subject: MOD, place: { in: 'Window', slot: 'remove' } }));
  assert.deepEqual(log.slice(1).map(([k, r]) => [k, r.props.place.slot]), [['remove', 'consent'], ['put', 'remove']]);
  root.unmount();
  assert.deepEqual(log.at(-1)[0], 'remove');
});

test('nothing without a reporter, a subject, or a type the framework reports; its bindings are its own', () => {
  const { React, ReactDOM } = createFakeReact();
  const log = [];
  const ctx = { report: { put: (rec) => log.push(rec), remove() {} } };
  const root = ReactDOM.createRoot({});
  root.render(React.createElement(createReport(React, {}), { type: 'Dialog', subject: MOD }));
  root.render(React.createElement(createReport(React, ctx), { type: 'Dialog', subject: null }));
  root.render(React.createElement(createReport(React, ctx), { type: 'SidebarItem', subject: MOD }));
  assert.equal(log.length, 0);
  assert.deepEqual(REPORTED, ['SettingsPage', 'SettingsRow', 'Dialog', 'NotificationBanner', 'ComposerPicker', 'DetailView', 'Page', 'Region']);
  assert.ok(FRAMEWORK_BINDINGS.every((b) => b.framework === true && b.id === `framework:${b.presentation}`));
  assert.deepEqual(FRAMEWORK_BINDINGS[0].place({ place: { in: 'Window', slot: 'main' } }), { in: 'Window', slot: 'main' });
  assert.equal(FRAMEWORK_BINDINGS[0].subject({}), null);
});
