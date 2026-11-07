'use strict';
// Branch history and git mutations through the app's worker (breadth D7). Review entries carry the worker's current revision; never
// construct staging entries from paths alone. Commits deliberately carry no attribution trailer.
const path = require('node:path');
const kit = require('../area-kit.cjs');

function pathsNeeded(paths, { empty = false } = {}) {
  if (!Array.isArray(paths) || (!empty && !paths.length) || paths.length > 500 || paths.some((p) => typeof p !== 'string' || !p.length
    || p.includes('\0') || path.isAbsolute(p) || path.normalize(p) === '..' || path.normalize(p).startsWith(`..${path.sep}`))) {
    throw kit.refusal('give at most 500 repository-relative file paths');
  }
}

function register(hooks) {
  hooks.onAreaOp('history', async (op, args = {}) => {
    if (!['commits', 'stage', 'unstage', 'commit', 'staged-elsewhere'].includes(op)) throw kit.refusal(`unknown operation ${op}`);
    const { cwd } = args;
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.includes('\0')) throw kit.refusal('an absolute project folder is needed');
    if (op === 'stage' || op === 'unstage' || (op === 'commit' && args.paths !== undefined)) pathsNeeded(args.paths);
    if (op === 'staged-elsewhere') pathsNeeded(args.paths, { empty: true });
    if (op === 'commits' && (!Array.isArray(args.known) || args.known.some((sha) => typeof sha !== 'string' || !sha))) throw kit.refusal('known commit shas are needed');
    const message = typeof args.message === 'string' ? args.message.trim() : '';
    if (op === 'commit' && (!message || message.length > 20_000)) throw kit.refusal('give a commit message of at most 20000 characters');

    const { services } = kit.windowServices(hooks);
    const openIn = services.openIn;
    if (typeof openIn?.requestGitWorker !== 'function') throw kit.refusal("the app's git worker is not available");
    const git = (method, params) => kit.withTimeout(openIn.requestGitWorker({ method, params }));
    let root = null;
    if (typeof services.repositoryOrigins?.read === 'function') {
      const r = await kit.withTimeout(services.repositoryOrigins.read({ dirs: [cwd], hostId: 'local' }, 'git_direct_call'));
      root = (r?.origins ?? []).find((o) => typeof o?.root === 'string' && path.isAbsolute(o.root))?.root ?? null;
    }
    if (!root) {
      try {
        const r = await git('stable-metadata', { cwd, operationSource: 'git_direct_call' });
        if (!r?.error && typeof r?.root === 'string' && path.isAbsolute(r.root)) root = r.root;
      } catch { /* the folder is not in a repository, as in readRepository */ }
    }
    if (!root) throw kit.refusal('the folder is not in a git repository');

    async function summary(source, operationSource, commitSha) {
      const r = await git('review-summary', { cwd: root, source, ...(commitSha ? { commitSha } : {}), operationSource });
      if (r?.type !== 'success') throw new Error(r?.error ?? r?.message ?? `the ${source} changes could not be read (${r?.type ?? 'unknown'})`);
      return r.files;
    }
    async function stage(action, paths) {
      const source = action === 'stage' ? 'unstaged' : 'staged';
      const rows = await summary(source, 'review_patch');
      const wanted = new Set(paths);
      const files = rows.filter((f) => wanted.has(f.path) || wanted.has(f.previousPath));
      const found = new Set(files.flatMap((f) => [f.path, f.previousPath]));
      const missing = paths.filter((p) => !found.has(p));
      if (missing.length) throw kit.refusal(`${action === 'stage' ? 'nothing to stage' : 'nothing staged'} for: ${missing.join(', ')}`);
      const r = await git('apply-review-section-changes', { action, cwd: root, files, operationSource: 'review_patch', source });
      if (r?.status !== 'success') throw new Error(`${action}: ${r?.status ?? 'unknown'}; skipped: ${(r?.skippedPaths ?? []).join(', ')}; conflicted: ${(r?.conflictedPaths ?? []).join(', ')}${r?.errorCode ? `; ${r.errorCode}` : ''}`);
    }

    if (op === 'commits') {
      const r = await git('branch-commits', { root });
      if (!Array.isArray(r?.commits)) throw new Error(r?.error ?? 'the branch commits could not be read');
      const known = new Set(args.known);
      const commits = r.commits.map(({ sha, message, committedAt }) => ({ sha, message, committedAt }));
      const fresh = commits.filter((c) => !known.has(c.sha));
      for (const c of fresh) {
        try { c.files = (await summary('commit', 'git_direct_call', c.sha)).length; } catch { c.files = null; }
      }
      for (let i = 0; i < fresh.length; i += 4) {
        const batch = fresh.slice(i, i + 4);
        let objects = [];
        try { objects = await git('cat-file', { cwd: root, requests: batch.map((c) => ({ oid: c.sha })) }); } catch { /* author unavailable */ }
        for (const [j, c] of batch.entries()) {
          const line = objects?.[j]?.type === 'success' ? objects[j].lines?.find((l) => l.startsWith('author ')) : null;
          c.author = line?.match(/^author (.*?) </)?.[1] ?? null;
        }
      }
      return { root, commits };
    }
    if (op === 'stage' || op === 'unstage') { await stage(op, args.paths); return {}; }
    if (op === 'staged-elsewhere') {
      const wanted = new Set(args.paths);
      return (await summary('staged', 'git_direct_call')).filter((f) => !wanted.has(f.path)).map((f) => f.path);
    }
    let includeUnstaged = true;
    if (args.paths !== undefined) { await stage('stage', args.paths); includeUnstaged = false; }
    else {
      try { includeUnstaged = kit.globalState(hooks).get('git-action-include-unstaged-changes') ?? true; } catch { /* the app's default */ }
    }
    const r = await git('commit', { cwd: root, message, includeUnstaged, commitAttribution: null, operationSource: 'git_direct_call' });
    if (r?.status === 'success') return { commitSha: r.commitSha };
    if (r?.errorType === 'nothing-to-commit') throw kit.refusal('there is nothing to commit');
    throw r?.error instanceof Error ? r.error : new Error(r?.error ?? 'the commit failed');
  });
}

module.exports = { register };
