'use strict';
// CommonJS mirror of contracts/layout.mjs for framework-main, which is synchronous CommonJS and cannot import ESM.
// layout.test.mjs asserts that this stays identical to the contract.
const { join } = require('node:path');

function layout(root, profile = 'default') {
  const p = join(root, 'profiles', profile);
  return Object.freeze({
    root,
    profile,
    framework: join(root, 'framework'),
    frameworkCurrent: join(root, 'framework', 'current'),
    frameworkPrevious: join(root, 'framework', 'previous'),
    frameworkLkg: join(root, 'framework', 'lkg'),
    adapters: join(root, 'adapters'),
    apps: join(root, 'apps'),
    store: join(root, 'store'),
    updates: join(root, 'updates'),
    profileDir: p,
    userData: join(p, 'userData'),
    codexHome: join(p, 'codex-home'),
    profileConfig: join(p, 'profile.json'),
    state: join(p, 'state.json'),
    ops: join(p, 'ops'),
    generations: join(p, 'generations'),
    data: join(p, 'data'),
    retained: join(p, 'retained'),
    snapshots: join(p, 'snapshots'),
    orphaned: join(p, 'orphaned'),
    backends: join(p, 'backends'),
    flags: join(p, 'flags'),
    graph: join(p, 'graph'),                            // the graph runtime's intent journal (intents.jsonl); never in the Codex home
    computerUse: join(p, 'computer-use'),
    profileUpdates: join(p, 'updates'),
    lkgApp: join(p, 'lkg-app'),
    logs: join(p, 'logs'),
    run: join(p, 'run'),
  });
}

module.exports = { layout };
