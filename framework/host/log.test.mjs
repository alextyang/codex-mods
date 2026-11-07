import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLog } from './log.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'cm-log-'));

test('JSONL records with level filtering, scope and 0600 mode', () => {
  const dir = tmp();
  try {
    const file = join(dir, 'logs', 'host.log');
    const log = createLog({ file, level: 'info' });
    log.debug('hidden'); log.info('hello', { a: 1 }); log.child('mux').warn('careful'); log.child('mux').child('x').error('bad');
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => [l.level, l.scope, l.msg]), [['info', 'host', 'hello'], ['warn', 'host/mux', 'careful'], ['error', 'host/mux/x', 'bad']]);
    assert.deepEqual(lines[0].data, { a: 1 });
    assert.ok(Date.parse(lines[0].t));
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rotation: at the size limit the file moves to .1 and exactly one previous file is kept', () => {
  const dir = tmp();
  try {
    const file = join(dir, 'host.log');
    const log = createLog({ file, level: 'debug', maxBytes: 600 });
    for (let i = 0; i < 40; i++) log.info(`line ${i}`, { pad: 'x'.repeat(40) });
    assert.ok(existsSync(`${file}.1`));
    assert.ok(!existsSync(`${file}.2`));
    assert.ok(statSync(file).size <= 600 && statSync(`${file}.1`).size <= 600);
    const all = readFileSync(`${file}.1`, 'utf8') + readFileSync(file, 'utf8');
    assert.match(all, /line 39/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rotation honors an existing oversize file at startup; default limit is 5 MB', () => {
  const dir = tmp();
  try {
    const file = join(dir, 'host.log');
    writeFileSync(file, 'x'.repeat(5 * 1024 * 1024 - 5));
    const log = createLog({ file });
    log.info('this pushes it over');
    assert.ok(existsSync(`${file}.1`));
    assert.match(readFileSync(file, 'utf8'), /this pushes it over/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an unwritable path never throws; unserializable data is tolerated; close stops writing', () => {
  const log = createLog({ file: '/dev/null/nope/host.log' });
  log.info('x');
  const dir = tmp();
  try {
    const l2 = createLog({ file: join(dir, 'h.log') });
    const cyc = {}; cyc.self = cyc;
    l2.info('cyc', cyc);
    l2.close(); l2.info('after close');
    const text = readFileSync(join(dir, 'h.log'), 'utf8');
    assert.match(text, /unserializable/); assert.doesNotMatch(text, /after close/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
