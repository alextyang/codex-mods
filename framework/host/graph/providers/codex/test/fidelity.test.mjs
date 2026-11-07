// The native provider's fidelity accounting (providers/codex/fidelity.mjs, graph-integrity G1.8) against the pinned build's schema: every
// notification, every field of a mapped definition, every item kind and its fields is mapped or left out with a reason, and nothing listed
// is gone from the schema. A new build's schema run through this test shows what it added.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PINNED, NOTIFICATIONS, FIELDS, REQUESTS, ITEMS } from '../fidelity.mjs';
import { itemData } from '../map.mjs';

const dir = new URL(`../../../../../../contracts/upstream/${PINNED}/schema/`, import.meta.url);
const json = (name) => JSON.parse(readFileSync(new URL(name, dir), 'utf8'));
// the v2 bundle's definitions, and those the request files define for themselves (a question's prompts and options)
const defs = { ...Object.fromEntries(['ToolRequestUserInputParams.json'].flatMap((f) => Object.entries(json(f).definitions ?? {}))), ...json('codex_app_server_protocol.v2.schemas.json').definitions };
const keysOf = (schema) => Object.keys(schema?.properties ?? {}).sort();

/** What disagrees between the schema's fields and an accounting entry. */
function diff(where, fields, entry) {
  const out = [];
  const reasons = entry.unmapped ?? {};
  for (const [name, why] of Object.entries(reasons)) if (typeof why !== 'string' || why.length < 10) out.push(`${where}.${name}: a reason it is left out`);
  const listed = [...entry.mapped, ...Object.keys(reasons)];
  for (const name of entry.mapped) if (Object.hasOwn(reasons, name)) out.push(`${where}.${name}: both mapped and left out`);
  for (const name of fields) if (!listed.includes(name)) out.push(`${where}.${name}: in the schema, neither mapped nor left out`);
  for (const name of listed) if (!fields.includes(name)) out.push(`${where}.${name}: listed, but not in the schema`);
  return out;
}

test('every server notification of the pinned build is realized or left out with a reason, and every one listed exists', () => {
  const methods = json('ServerNotification.json').oneOf.map((v) => v.properties.method.enum[0]).sort();
  const problems = diff('notification', methods, NOTIFICATIONS);
  assert.deepEqual(problems, []);
});

test('every field of the definitions the provider maps is mapped or left out with a reason', () => {
  const problems = [];
  for (const [name, entry] of Object.entries(FIELDS)) {
    const def = defs[name];
    if (!def) { problems.push(`${name}: not in the schema`); continue; }
    problems.push(...diff(name, keysOf(def), entry));
  }
  for (const [file, entry] of Object.entries(REQUESTS)) problems.push(...diff(file, keysOf(json(file)), entry));
  assert.deepEqual(problems, []);
});

test('every thread item kind becomes its step or message, its fields mapped or left out with a reason', () => {
  const variants = defs.ThreadItem.oneOf.map((v) => [v.properties.type.enum[0], keysOf(v).filter((k) => k !== 'type')]);
  const problems = [];
  for (const [kind, fields] of variants) {
    const entry = ITEMS[kind];
    if (!entry) { problems.push(`item ${kind}: neither mapped nor left out`); continue; }
    problems.push(...diff(`item ${kind}`, fields, entry));
  }
  for (const kind of Object.keys(ITEMS)) if (!variants.some(([k]) => k === kind)) problems.push(`item ${kind}: listed, but not in the schema`);
  assert.deepEqual(problems, []);
  // and each becomes the type the accounting names
  const sample = { webSearch: { query: 'q', action: { type: 'search', query: 'q' } }, collabAgentToolCall: { receiverThreadIds: ['child'], tool: 'spawn', status: 'completed' },
    mcpToolCall: { server: 's', tool: 't', status: 'completed' }, dynamicToolCall: { tool: 't', status: 'completed' }, fileChange: { status: 'completed', changes: [{ path: 'a' }] },
    commandExecution: { command: 'ls', cwd: '/', status: 'completed' } };
  for (const [kind, entry] of Object.entries(ITEMS)) {
    const [first] = itemData('t', 'u', { type: kind, id: 'x', ...(sample[kind] ?? {}) }, { done: true });
    assert.equal(first.ref.type, entry.type, kind);
  }
});
