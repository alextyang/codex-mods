'use strict';
// GitHub pull requests through the app's github service and its disposable git-worker handles (breadth D7).
const path = require('node:path');
const kit = require('../area-kit.cjs');
const { own } = require('../user-actions.cjs');

function parseUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value), match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
    const hostname = url.hostname.trim().toLowerCase().replace(/\.+$/, '');
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || !hostname || !match) return null;
    const number = Number(match[3]);
    if (!Number.isSafeInteger(number) || number <= 0) return null;
    return { hostname, owner: match[1].toLowerCase(), repository: match[2].toLowerCase(), number };
  } catch { return null; }
}

function register(hooks) {
  const accounts = new Map(); // hostname -> the app's gh account, kept for 60 seconds
  async function github(method, params, source) {
    const { svc } = kit.service(hooks, 'github', ['request']);
    // framework-main's own request (the graph's, which passed the mods already): never held as the user's merge (user-actions.cjs)
    const handle = own(svc, 'request', method, params, source);
    try { return await kit.withTimeout(handle.wait()); }
    finally { try { handle[Symbol.dispose]?.(); } catch { /* settled or gone */ } }
  }
  async function accountFor(hostname) {
    const cached = accounts.get(hostname);
    if (cached && Date.now() - cached.time < 60_000) return cached.account;
    let r;
    try { r = await github('gh-current-user', { hostId: 'local', hostname }, 'pull_requests_page'); }
    catch (e) { throw kit.refusal(String(e?.message ?? e)); }
    if (r?.status !== 'success') throw kit.refusal(r?.error ?? 'the GitHub account is not available');
    accounts.set(hostname, { account: r.account, time: Date.now() });
    return r.account;
  }
  async function repositoryRoot(cwd) {
    const { services } = kit.windowServices(hooks);
    let root = null;
    if (typeof services.repositoryOrigins?.read === 'function') {
      const r = await kit.withTimeout(services.repositoryOrigins.read({ dirs: [cwd], hostId: 'local' }, 'git_direct_call'));
      root = (r?.origins ?? []).find((o) => typeof o?.root === 'string' && path.isAbsolute(o.root))?.root ?? null;
    }
    if (!root && typeof services.openIn?.requestGitWorker === 'function') {
      try {
        const r = await kit.withTimeout(services.openIn.requestGitWorker({ method: 'stable-metadata', params: { cwd, operationSource: 'git_direct_call' } }));
        if (!r?.error && typeof r?.root === 'string' && path.isAbsolute(r.root)) root = r.root;
      } catch { /* not a repository, as in history */ }
    }
    if (!root) throw kit.refusal('the folder is not in a git repository');
    return root;
  }
  const failure = (r) => r?.error instanceof Error ? r.error : new Error(r?.error ?? 'the GitHub operation failed');
  async function summary(params) {
    const r = await github('gh-pr-summary', params, 'pull_requests_page');
    if (r?.status !== 'success') throw kit.refusal(`the pull request is not available: ${r?.status ?? 'unavailable'}`);
    return r;
  }

  hooks.onAreaOp('pull-requests', async (op, args = {}) => {
    if (!['status', 'board', 'details', 'mark-ready', 'merge', 'create', 'open'].includes(op)) throw kit.refusal(`unknown operation ${op}`);
    if (op === 'board' || op === 'create') {
      if (typeof args.cwd !== 'string' || !path.isAbsolute(args.cwd) || args.cwd.includes('\0')) throw kit.refusal('an absolute project folder is needed');
    }
    if (op === 'create') {
      if (typeof args.headBranch !== 'string' || !args.headBranch.trim() || args.headBranch.length > 250 || args.headBranch.includes('\0')) throw kit.refusal('a branch name of at most 250 characters is needed');
      if (args.title !== undefined && (typeof args.title !== 'string' || args.title.length > 300)) throw kit.refusal('give a title of at most 300 characters');
      if (args.body !== undefined && (typeof args.body !== 'string' || args.body.length > 60_000)) throw kit.refusal('give a body of at most 60000 characters');
      if (args.base !== undefined && (typeof args.base !== 'string' || !args.base.trim() || args.base.length > 250 || args.base.includes('\0'))) throw kit.refusal('a base branch name of at most 250 characters');
      if (args.draft !== undefined && typeof args.draft !== 'boolean') throw kit.refusal('draft is true or false');
    }
    let pullRequest;
    if (!['status', 'board', 'create'].includes(op)) {
      pullRequest = parseUrl(args.url);
      if (!pullRequest) throw kit.refusal('a GitHub pull request url is needed');
    }
    if (op === 'open') { await hooks.electron.openExternal(args.url); return {}; }
    if (op === 'status') {
      try {
        const r = await github('gh-cli-status', { hostId: 'local' }, 'git_direct_call');
        const available = r?.isInstalled === true && r?.isAuthenticated === true;
        return available ? { available } : { available, reason: r?.isInstalled !== true ? 'the gh CLI is not installed' : 'the gh CLI is not signed in' };
      } catch (e) {
        if (e?.refused) throw e; // nothing was tried (no window yet): the Host asks again soon
        return { available: false, reason: String(e?.message ?? e) };
      }
    }
    if (op === 'board' || op === 'create') {
      const root = await repositoryRoot(args.cwd);
      if (op === 'board') {
        const r = await github('gh-pr-board', { cwd: root, hostId: 'local' }, 'pull_request_board');
        if (r?.status !== 'success') throw kit.refusal(r?.error ?? 'the pull requests could not be read');
        const fields = ['title', 'number', 'url', 'state', 'ciStatus', 'canMerge', 'mergeBlocker', 'headBranch', 'baseBranch', 'additions', 'deletions', 'createdAt', 'updatedAt', 'isAuthor', 'cwd', 'hostId'];
        return { items: r.items.map((item) => Object.fromEntries(fields.filter((key) => Object.hasOwn(item, key)).map((key) => [key, item[key]]))) };
      }
      const r = await github('gh-pr-create', { cwd: root, hostId: 'local', headBranch: args.headBranch,
        ...(args.title ? { titleOverride: args.title } : {}), ...(args.body ? { bodyOverride: args.body } : {}), ...(args.base ? { baseBranch: args.base } : {}),
        ...(typeof args.draft === 'boolean' ? { isDraft: args.draft } : {}) }, 'local_conversation_git_actions');
      if (r?.status !== 'success') throw failure(r);
      return { url: r.url };
    }
    const params = { account: await accountFor(pullRequest.hostname), pullRequest };
    if (op === 'details') {
      const s = await summary(params);
      const reviews = await github('gh-pr-reviews', params, 'pull_requests_page');
      return { summary: s, reviews: reviews?.status === 'success' ? reviews : null };
    }
    let r;
    if (op === 'mark-ready') r = await github('gh-pr-update', { ...params, action: 'mark-ready' }, 'pull_requests_page');
    else {
      const s = await summary(params);
      if (s.state !== 'open') throw kit.refusal('the pull request is not open');
      const mergeMethod = kit.globalState(hooks).get('git-pull-request-merge-method') ?? 'merge';
      r = await github('gh-pr-merge', { ...params, mergeMethod, expectedHeadRevision: s.headRevision }, 'pull_requests_page');
    }
    if (r?.status !== 'success') throw failure(r);
    return {};
  });
}

module.exports = { register };
