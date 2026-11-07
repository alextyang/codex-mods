// The user's PATH (graph-integrity G8.2, D4): read from their login shell (a greeting it prints first is not the PATH), the Host's own when
// no shell answers; a program found by its name alone, the first executable file of that name on it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUserPath } from './user-path.mjs';

const script = async (dir, name, body, mode = 0o755) => { const f = join(dir, name); await writeFile(f, `#!/bin/sh\n${body}\n`); await chmod(f, mode); return f; };

test('G8.2: the PATH as the user\'s login shell sets it, past what it prints first; the Host\'s own when no shell answers', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'cm-upath-')));
  // called as `<shell> -ilc <command>`: greets, sets its PATH, runs the command
  const shell = await script(dir, 'shell', 'echo "Welcome back"\nPATH=/opt/user/bin:/usr/bin; export PATH\neval "$2"');
  assert.equal(await createUserPath({ shell }).path(), '/opt/user/bin:/usr/bin');
  const asked = [];
  const none = createUserPath({ shell: '/no/such/shell', read: async (sh) => { asked.push(sh); return null; }, fallback: () => '/fallback/bin' });
  assert.equal(await none.path(), '/fallback/bin', 'no shell answered');
  assert.deepEqual(asked, ['/no/such/shell', '/bin/zsh', '/bin/bash'], 'the user\'s shell first, then the system\'s');
  // read once a minute at most
  let reads = 0, t = 0;
  const cached = createUserPath({ read: async () => { reads++; return '/a'; }, now: () => t });
  await cached.path(); await cached.path();
  t += 60001;
  await cached.path();
  assert.equal(reads, 2);
});

test('G8.2: a program by its name alone: the first executable file of that name on the PATH; never a path or a folder', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'cm-which-')));
  const [a, b] = [join(dir, 'a'), join(dir, 'b')];
  await mkdir(a); await mkdir(b);
  await script(a, 'tool', 'true', 0o644);       // not executable
  await mkdir(join(a, 'dirtool'));               // a folder
  const found = await script(b, 'tool', 'true');
  await script(b, 'dirtool', 'true');
  const up = createUserPath({ read: async () => `relative/bin:${a}:${b}` });
  assert.equal(await up.which('tool'), found);
  assert.equal(await up.which('dirtool'), join(b, 'dirtool'));
  assert.equal(await up.which('missing'), null);
  assert.equal(await up.which('../b/tool'), null, 'a name, not a path');
  assert.equal(await up.which(`${b}/tool`), null);
});
