// Your repository's GitHub pull requests, read and changed through the app's gh worker (breadth D7). The first read is a sync;
// subsequent reads announce state/check changes. Thread associations are protocol attachments, kept even before a PR is listed.
import { refs } from '../map.mjs';

export const realizes = {
  types: ['GitHubPullRequest'],
  operations: { PullRequest: ['open', 'refresh', 'markReady', 'merge'], ChangeSet: ['openPullRequest'], Branch: ['openPullRequest'] },
  supports: { PullRequest: ['number', 'checks', 'reviewState'], GitHubPullRequest: ['reviewers'] },
  events: { PullRequest: ['stateChanged', 'checksChanged'] },
  links: { GitHubPullRequest: ['repository', 'branch', 'thread'], Branch: ['pullRequest'] },
};

export function parseUrl(value) {
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

export function identityKey({ hostname, owner, repository, number }) {
  return JSON.stringify([hostname.trim().toLowerCase().replace(/\.+$/, ''), owner.toLowerCase(), repository.toLowerCase(), number]);
}

export function pullRequestData(projectId, item, details) {
  const summary = details?.summary, reviews = details?.reviews;
  const state = summary ? summary.state === 'open' && summary.isDraft ? 'draft' : summary.state
    : item.state === 'draft' || item.state === 'merged' ? item.state : 'open';
  const reviewState = { approved: 'approved', changes_requested: 'changesRequested', review_required: 'pending' };
  const review = reviews && Object.hasOwn(reviewState, reviews.reviewStatus) ? reviewState[reviews.reviewStatus] : undefined;
  return { ref: { type: 'GitHubPullRequest', provider: 'codex', id: item.url },
    state: { title: summary?.title ?? item.title, state, url: item.url, number: item.number, checks: summary?.ciStatus ?? item.ciStatus,
      ...(review ? { reviewState: review } : {}), ...(reviews ? { reviewers: [...new Set(['approved', 'changesRequested', 'commented', 'requested'].flatMap((key) => reviews.reviewers?.[key] ?? []))] } : {}) },
    links: { repository: refs.repository(projectId), branch: refs.branch(projectId, item.headBranch), thread: details?.thread ?? null } };
}

export function types(feed) {
  const operation = (op, effect) => ({ effect,
    ...(effect === 'external' ? { approval: ({ instance, args }) => feed().prompt(op, instance, args) } : {}),
    handler: ({ instance, args, intent }) => feed().run(op, instance, args, intent) });
  return {
    PullRequest: { operations: { open: operation('open', 'local'), refresh: operation('refresh', 'local'),
      markReady: operation('markReady', 'external'), merge: operation('merge', 'external') } },
    ChangeSet: { operations: { openPullRequest: operation('openPullRequest', 'external') } },
    Branch: { operations: { openPullRequest: operation('openPullRequest', 'external') } },
  };
}

const refused = (reason, message) => ({ status: 'refused', reason, message });
const ownBranch = () => refused('unavailable', 'open a pull request from a branch of its own');

export function createFeed(ctx) {
  const now = ctx.now ?? Date.now;
  const projects = new Map(); // project id -> {items, reading, again, finishedAt}
  const attached = new Map(); // normalized PR identity -> thread ref
  let disposed = false, available = false, statusRead = null, checkedAt = -Infinity, why = 'not checked yet';

  async function mainOp(op, args) {
    const r = await ctx.mainOp(op, args);
    if (r.ok) return { result: r.result };
    if (r.refused) return { no: refused('unavailable', r.error) };
    throw new Error(r.error);
  }
  function status() {
    if (disposed || !ctx.serverUp()) return Promise.resolve();
    if (statusRead) return statusRead;
    if (now() - checkedAt < 300_000) return Promise.resolve();
    statusRead = (async () => {
      let retry = false;
      try {
        const r = await ctx.mainOp('status', {});
        if (!disposed) available = r.ok && r.result.available === true;
        why = available ? null : r.ok ? r.result.reason ?? 'gh is not installed or not signed in' : r.error;
        // Refused (the app has no window yet, as at its start): ask again soon, not in five minutes.
        retry = !r.ok && r.refused === true;
        if (!available) ctx.log.warn('pull-requests: GitHub is not available', { message: r.ok ? r.result.reason ?? 'gh is not installed or not signed in' : r.error });
      } catch (e) { available = false; why = String(e?.message ?? e); ctx.log.warn('pull-requests: GitHub is not available', { message: String(e?.message ?? e) }); }
      finally { checkedAt = retry ? -Infinity : now(); }
      if (retry && !disposed) { const t = setTimeout(() => { status().then(() => readAll()); }, 15_000); t.unref?.(); }
    })().finally(() => { statusRead = null; });
    return statusRead;
  }
  function projectState(id) {
    if (!projects.has(id)) projects.set(id, { items: new Map(), reading: null, again: false, finishedAt: -Infinity });
    return projects.get(id);
  }
  function find(url) {
    for (const [projectId, p] of projects) if (p.items.has(url)) return { projectId, record: p.items.get(url) };
    return null;
  }
  function applyBranch(branch) {
    const projectId = branch.links.repository?.id, p = projects.get(projectId);
    if (!p) return;
    const repo = ctx.resident(refs.repository(projectId));
    const pr = repo?.links.currentBranch?.id === branch.ref.id
      ? [...p.items.values()].find((r) => r.item.headBranch === branch.state.name && ['open', 'draft'].includes(r.data.state.state))?.data.ref ?? null : null;
    if ((branch.links.pullRequest?.id ?? null) !== (pr?.id ?? null)) ctx.safe('branch pull request', () => ctx.handle.update(branch.ref, { links: { pullRequest: pr } }));
  }
  function applyBranches(projectId) {
    for (const branch of ctx.graph.referrers(refs.repository(projectId), 'repository')) {
      if (branch.ref.provider === 'codex' && branch.ref.type === 'Branch') applyBranch(branch);
    }
  }
  function put(projectId, record, before) {
    const thread = attached.get(identityKey(parseUrl(record.item.url))) ?? null;
    record.data = pullRequestData(projectId, record.item, { ...record.details, thread });
    ctx.safe('pull request', () => ctx.handle.put(record.data.ref, { state: record.data.state, links: record.data.links }));
    if (before && before.state.state !== record.data.state.state) ctx.emitEvent(record.data.ref, 'stateChanged');
    if (before && before.state.checks !== record.data.state.checks) ctx.emitEvent(record.data.ref, 'checksChanged');
  }
  function read(projectId) {
    if (disposed || !available || !ctx.serverUp() || !ctx.resident(refs.repository(projectId))) return Promise.resolve();
    const project = ctx.resident(refs.project(projectId));
    if (!project) return Promise.resolve();
    const p = projectState(projectId);
    if (p.reading) { p.again = true; return p.reading; }
    p.reading = (async () => {
      do {
        p.again = false;
        try {
          const r = await ctx.mainOp('board', { cwd: project.state.location });
          if (!r.ok) throw new Error(r.error);
          if (disposed || !ctx.serverUp()) return;
          const next = new Map();
          for (const item of r.result.items) {
            if (!parseUrl(item.url)) continue;
            const record = { item, details: null };
            if (item.state !== 'merged') {
              try {
                const d = await ctx.mainOp('details', { url: item.url });
                if (!d.ok) throw new Error(d.error);
                record.details = d.result;
              } catch (e) { ctx.log.warn('pull requests: details could not be read', { message: String(e?.message ?? e) }); }
            }
            if (disposed || !ctx.serverUp()) return;
            next.set(item.url, record);
            put(projectId, record, p.items.get(item.url)?.data);
          }
          for (const [url, record] of p.items) if (!next.has(url)) ctx.safe('pull request removal', () => ctx.handle.remove(record.data.ref));
          p.items = next;
          applyBranches(projectId);
        } catch (e) { ctx.log.warn('pull requests: the board could not be read', { message: String(e?.message ?? e) }); }
        finally { p.finishedAt = now(); }
      } while (p.again && !disposed && available && ctx.serverUp());
    })().finally(() => { p.reading = null; });
    return p.reading;
  }
  const readAll = () => Promise.all(ctx.graph.list('GitRepository').filter((r) => r.ref.provider === 'codex').map((r) => read(r.ref.id)));
  async function refresh(projectId, record) {
    const r = await mainOp('details', { url: record.item.url });
    if (r.no) return r.no;
    if (!disposed) { record.details = r.result; put(projectId, record, record.data); applyBranches(projectId); }
    return null;
  }
  function plan(op, instance, args) {
    if (disposed) return { no: refused('unavailable', 'pull requests is disposed') };
    if (!ctx.serverUp()) return { no: ctx.DOWN };
    if (!available) return { no: refused('unavailable', `GitHub pull requests are not available: ${why}`) };
    if (op !== 'openPullRequest') {
      const p = find(instance.ref.id);
      if (!p || !ctx.resident(instance.ref)) return { no: refused('unavailable', 'the pull request is not available') };
      const { state, checks } = p.record.data.state;
      if (op === 'markReady' && state !== 'draft') return { no: refused('unavailable', 'the pull request is not a draft') };
      if (op === 'merge' && state !== 'open') return { no: refused('unavailable', 'the pull request is not open') };
      if (op === 'merge' && ['failing', 'pending'].includes(checks)) return { no: refused('unavailable', 'its checks have not passed') };
      return p;
    }
    // a branch's own (H6m4): the branch named, on its project's folder; the current one is pushed first (only if it is still the one
    // checked out when it is read), another is opened as it is on the code host (gh says so when it is not there)
    if (instance.ref.type === 'Branch') {
      // a Branch's id is `<project>:<name>`, and a git branch's name has no `:`
      const projectId = instance.ref.id.slice(0, instance.ref.id.lastIndexOf(':'));
      const project = projectId ? ctx.resident(refs.project(projectId)) : null;
      const repo = projectId ? ctx.resident(refs.repository(projectId)) : null;
      const name = instance.state?.name;
      const current = !!repo?.links.currentBranch && repo.links.currentBranch.id === instance.ref.id;
      if (!project || !repo || typeof name !== 'string' || !name.trim() || name.length > 250 || name.includes('\0')) return { no: refused('unavailable', 'the branch is not available') };
      const o = args[0] ?? {};
      if (!o || typeof o !== 'object' || Array.isArray(o)) return { no: refused('invalid', 'the options are an object') };
      if (o.title !== undefined && (typeof o.title !== 'string' || o.title.length > 300)) return { no: refused('invalid', 'give a title of at most 300 characters') };
      if (o.body !== undefined && (typeof o.body !== 'string' || o.body.length > 60_000)) return { no: refused('invalid', 'give a body of at most 60000 characters') };
      if (o.base !== undefined && (typeof o.base !== 'string' || !o.base.trim() || o.base.length > 250 || o.base.includes('\0'))) return { no: refused('invalid', 'give a base branch name of at most 250 characters') };
      if (o.draft !== undefined && typeof o.draft !== 'boolean') return { no: refused('invalid', 'draft is true or false') };
      if (o.base === name) return { no: refused('invalid', 'the base is the branch itself') };
      return { projectId, branch: true, current, cwd: project.state.location, name, title: o.title, body: o.body, base: o.base, draft: o.draft };
    }
    const thread = instance.links.thread ? ctx.resident(instance.links.thread) : null;
    const projectId = thread?.links.project?.id, project = projectId ? ctx.resident(refs.project(projectId)) : null;
    const repo = projectId ? ctx.resident(refs.repository(projectId)) : null;
    const branch = repo?.links.currentBranch ? ctx.resident(repo.links.currentBranch) : null;
    const name = branch?.state.name;
    const bases = new Set(['main', 'master', ...[...(projects.get(projectId)?.items.values() ?? [])].map((r) => r.item.baseBranch)]);
    if (!thread || !project || !repo || !name || bases.has(name)) return { no: ownBranch() };
    if (name.length > 250 || !name.trim() || name.includes('\0')) return { no: ownBranch() };
    if (args[0] !== undefined && (typeof args[0] !== 'string' || args[0].length > 300)) return { no: refused('invalid', 'give a title of at most 300 characters') };
    if (args[1] !== undefined && (typeof args[1] !== 'string' || args[1].length > 60_000)) return { no: refused('invalid', 'give a body of at most 60000 characters') };
    return { projectId, thread, cwd: project.state.location, name, title: args[0], body: args[1] };
  }
  const sub = ctx.graph.onEvent((e) => {
    if (!disposed && e.ref?.provider === 'codex' && e.ref.type === 'Branch' && ['added', 'changed'].includes(e.kind)) applyBranch(e.instance);
  });
  const timer = setInterval(() => { readAll(); }, 120_000);
  const statusTimer = setInterval(async () => { await status(); await readAll(); }, 300_000);
  timer.unref?.(); statusTimer.unref?.();

  return {
    read,
    async start() { await status(); await readAll(); },
    async serverUp() { await status(); await readAll(); },
    observe(ref, concept) {
      if (concept !== 'PullRequest') return undefined;
      const known = find(ref.id);
      if (!known) return Promise.resolve();
      const p = projects.get(known.projectId);
      return p.reading ?? (now() - p.finishedAt > 30_000 ? read(known.projectId) : Promise.resolve());
    },
    notified(method, p) {
      if (disposed || method !== 'thread/attachment/updated' || p.attachmentType !== 'pull_request') return;
      if (p.operation === 'created') attached.set(p.identityKey, refs.thread(p.threadId));
      else if (p.operation === 'deleted' && attached.get(p.identityKey)?.id === p.threadId) attached.delete(p.identityKey);
      else return;
      for (const [projectId, project] of projects) for (const record of project.items.values()) {
        if (identityKey(parseUrl(record.item.url)) === p.identityKey) put(projectId, record, record.data);
      }
    },
    prompt(op, instance, args) {
      const p = plan(op, instance, args);
      if (p.no) return null;
      if (op === 'openPullRequest' && p.branch) return { action: `open a pull request of the branch ${p.name}`,
        detail: `${p.current ? `It pushes the branch and opens` : 'It opens'} a pull request${p.base ? ` into ${p.base}` : ''} on GitHub with your account.` };
      if (op === 'openPullRequest') return { action: `open a pull request for the changes of “${p.thread.state.title}”`,
        detail: `It pushes the branch ${p.name} and opens a pull request on GitHub with your account.` };
      const title = p.record.data.state.title;
      if (op === 'markReady') return { action: `mark the pull request “${title}” ready for review`, detail: 'GitHub shows it to its reviewers as ready.' };
      const setting = ctx.appState?.value('git-pull-request-merge-method');
      const method = setting?.effective ?? setting?.configured ?? 'merge';
      return { action: `merge the pull request “${title}”`, detail: `It merges on GitHub with your account (${method}); this cannot be undone from the app.` };
    },
    async run(op, instance, args, intent) {
      // a branch's: decided on the repository as it is now (which branch is checked out), never on what was read before
      if (op === 'openPullRequest' && instance.ref.type === 'Branch') {
        try { await ctx.readRepository(instance.ref.id.slice(0, instance.ref.id.lastIndexOf(':'))); } catch { return refused('unavailable', 'the repository could not be read'); }
      }
      const p = plan(op, instance, args);
      if (p.no) return p.no;
      if (op === 'openPullRequest' && p.branch) {
        if (p.current) { const pushed = await ctx.pushRepository(p.projectId, p.name); if (pushed) return pushed; }
        try {
          const r = await mainOp('create', { cwd: p.cwd, headBranch: p.name, title: p.title, body: p.body, base: p.base, draft: p.draft });
          if (r.no) return r.no;
          if (!parseUrl(r.result.url)) throw new Error('the app returned an invalid pull request url');
          for (let i = 0; i < 4 && !disposed; i++) {
            await read(p.projectId);
            if (find(r.result.url)) break;
            await new Promise((done) => { const t = setTimeout(done, 3_000); t.unref?.(); });
          }
          return { type: 'GitHubPullRequest', provider: 'codex', id: r.result.url };
        } finally { await read(p.projectId); }
      }
      if (op === 'openPullRequest') {
        const pushed = await ctx.pushRepository(p.projectId);
        if (pushed) return pushed;
        try {
          const r = await mainOp('create', { cwd: p.cwd, headBranch: p.name, title: p.title, body: p.body });
          if (r.no) return r.no;
          const parts = parseUrl(r.result.url);
          if (!parts) throw new Error('the app returned an invalid pull request url');
          const key = identityKey(parts);
          await ctx.request('thread/attachment/add', { threadId: p.thread.ref.id, attachmentType: 'pull_request', identityKey: key,
            payload: { url: r.result.url, root: p.cwd, headBranch: p.name } }, intent);
          attached.set(key, p.thread.ref);
          // GitHub lists a new pull request a little after it is made (natively the first board after the create had none yet).
          for (let i = 0; i < 4 && !disposed; i++) {
            await read(p.projectId);
            if (find(r.result.url)) break;
            await new Promise((done) => { const t = setTimeout(done, 3_000); t.unref?.(); });
          }
          return { type: 'GitHubPullRequest', provider: 'codex', id: r.result.url };
        } finally { await read(p.projectId); }
      }
      try {
        if (op === 'refresh') return await refresh(p.projectId, p.record);
        const r = await mainOp(op === 'markReady' ? 'mark-ready' : op, { url: p.record.item.url });
        if (r.no) return r.no;
        return op === 'open' ? null : await refresh(p.projectId, p.record);
      } finally { await read(p.projectId); }
    },
    /** A pull request named by its url, as listed: the listed one with the same identity (GitHub's names ignore case), else as given. */
    pullRequestRef(ref) {
      const key = parseUrl(ref?.id) ? identityKey(parseUrl(ref.id)) : null;
      if (!key) return ref;
      for (const p of projects.values()) for (const r of p.items.values()) if (identityKey(parseUrl(r.item.url)) === key) return { type: 'GitHubPullRequest', provider: 'codex', id: r.item.url };
      return ref;
    },
    dispose() { disposed = true; clearInterval(timer); clearInterval(statusTimer); sub.dispose(); },
  };
}
