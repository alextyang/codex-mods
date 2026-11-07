// Native types, area A of docs/graph/02-types.md: Setting and SettingsSection (breadth step D4). One definition per card, with the same
// builders a mod uses (define.mjs). Conventions are in threads.mjs. What is particular to these cards:
// - `value` and `default` are any JSON value (a setting's kind says which).
// - `definedBy` is what defines it: the App, an Agent, a Plugin, a Skill or a Mod, a relation to any of those concepts (graph-integrity
//   G3.3), so the settings of any one of them are a query (`Setting where definedBy = it`), whoever defined them. `key` names the setting
//   within what defines it, the same at every scope: a mod's setting is its declared key, an agent's its config key; so a chat's own
//   instance of a setting is the one of `Thread.settings` with its `definedBy` and `key` (no id names it).
// - SettingsSection.settings and Project.settings are the inverses of Setting.section and Setting.project; Thread's thread-scope settings
//   are reached from the thread (Setting.thread).
// - `overridden?` and `scopes?` (systems.md E3): a value is stored at this instance's scope (not inherited), and the scopes the setting may
//   be set at (a thread-scope setting has project and app defaults).
// - `configured?` (H7y): the value the user set, where the app uses another for now (its own policy); `value` is the one in effect.
import { defineConcept, ev, op, r, s } from '../define.mjs';

/** An image of a mod's (framework-ui.md F6): Mod.image gives it. */
const MEDIA = s.object({ id: s.string(), caption: s.string().optional(), aspect: s.string().optional() });

export const Setting = defineConcept('Setting', {
  state: {
    title: s.string(),
    key: s.string().optional(),   // the setting's key within what defines it, the same at every scope
    value: s.json(),
    default: s.json(),
    scope: s.enum('app', 'project', 'thread'),
    kind: s.enum('toggle', 'choice', 'text', 'number', 'shortcut', 'list', 'record', 'color', 'time', 'timerange'), // record: a structured value (card change of 2026-10-25)
    description: s.string().optional(),
    // a choice's `value` is the setting's value when it is chosen; absent, its `id` is the value (a provider whose values are all strings)
    choices: s.list(s.object({ id: s.string(), label: s.string(), value: s.json().optional(), description: s.string().optional(), media: MEDIA.optional() })).optional(),
    // docs/design/framework-ui.md F7: how it is drawn, and what a mod's says of itself; the app's own lack them
    control: s.enum('select', 'segmented', 'thumbnails', 'stepper', 'slider', 'line', 'area').optional(),
    icon: s.string().optional(),
    min: s.number().optional(),
    max: s.number().optional(),
    step: s.number().optional(),
    unit: s.string().optional(),
    placeholder: s.string().optional(),
    group: s.string().optional(),
    requires: s.object({ key: s.string(), not: s.json().optional() }).optional(),
    needs: s.string().optional(),
    structured: s.boolean().optional(),   // a list whose items are more than text, edited as JSON
    active: s.boolean().optional(),   // what it requires holds at this instance's scope; a row not active is not shown
    overridden: s.boolean().optional(),
    configured: s.json().optional(),
    scopes: s.list(s.enum('app', 'project', 'thread')).optional(),
  },
  relations: {
    section: r.one('SettingsSection'),
    definedBy: r.one(['App', 'Agent', 'Plugin', 'Skill', 'Mod']),
    project: r.maybe('Project'),
    thread: r.maybe('Thread'),
  },
  operations: { set: op({ args: [s.json()] }), reset: op() },
  events: { changed: ev() },
  summary: { title: 'title', subtitle: 'description' },
});

export const SettingsSection = defineConcept('SettingsSection', {
  state: {
    title: s.string(),
    description: s.string().optional(),
    icon: s.string().optional(),   // F7: a mod's group says these of itself
    media: MEDIA.optional(),
  },
  relations: {
    settings: r.many('Setting').inverse('section'),
    parent: r.maybe('SettingsSection'),
    children: r.many('SettingsSection').inverse('parent'),
  },
  operations: { resetAll: op().optional() },   // F7: every value stored at the app scope in this section, hidden rows included; never a project's or a chat's
  summary: { title: 'title', subtitle: 'description' },
});
