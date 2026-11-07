// A project's branch history and commits through the app's git worker (breadth D7). The area keeps immutable author/file facts and the
// thread of commits it made; repository status remains the git feed's. All mutations ask a mod's caller under R17.
import path from 'node:path';
import { refs } from '../map.mjs';

export const realizes = {
  types: ['Commit'],
  operations: { Repository: ['commit'], GitRepository: ['stage', 'unstage'], ChangeSet: ['commit'] },
  events: { Repository: ['committed'], ChangeSet: ['committed'] },
  links: { Commit: ['repository', 'branch', 'thread'] },
};

export function commitData(projectId, c, { branch, thread }) {
  return { ref: refs.commit(projectId, c.sha),
    state: { id: c.sha, message: c.message.trim(), author: c.author ?? '', time: Date.parse(c.committedAt), files: c.files ?? 0 },
    links: { repository: refs.repository(projectId), branch, thread } };
}

export function types(feed) {
  const operation = (op) => ({ effect: 'external',
    approval: ({ instance, args }) => feed().prompt(op, instance, args),
    handler: ({ instance, args }) => feed().run(op, instance, args) });
  return {
    Repository: { operations: { commit: operation('commit') } },
    GitRepository: { operations: { stage: operation('stage'), unstage: operation('unstage') } },
    ChangeSet: { operations: { commit: operation('commit') } },
  };
}

const refused = (reason, message) => ({ status: 'refused', reason, message });
const noMessage = () => refused('unsupported', 'give the commit a message: the app writes one only in its own commit dialog');
const validPaths = (files) => Array.isArray(files) && files.length > 0 && files.length <= 500
  && files.every((p) => typeof p === 'string' && p.length > 0 && !p.includes('\0'));
const relative = (p) => !path.isAbsolute(p) && path.normalize(p) !== '..' && !path.normalize(p).startsWith(`..${path.sep}`);

export function createFeed(ctx) {
  const now = ctx.now ?? Date.now;
  const projects = new Map(); // project id -> {commits, root, finishedAt, reading, again, heard}
  const committedFrom = new Map(); // sha -> the thread the area committed it from
  const made = new Set(); // commit ref ids already emitted by this area's operations
  let disposed = false;

  function projectState(id) {
    if (!projects.has(id)) projects.set(id, { commits: new Map(), root: null, finishedAt: -Infinity, reading: null, again: false, heard: false });
    return projects.get(id);
  }
  function read(projectId) {
    if (disposed || !ctx.serverUp() || !ctx.resident(refs.repository(projectId))) return Promise.resolve();
    const project = ctx.resident(refs.project(projectId));
    if (!project) return Promise.resolve();
    const p = projectState(projectId);
    if (p.reading) { p.again = true; return p.reading; }
    p.reading = (async () => {
      do {
        p.again = false;
        try {
          const r = await ctx.mainOp('commits', { cwd: project.state.location, known: [...p.commits.keys()] });
          if (!r.ok) throw new Error(r.error);
          if (disposed) return;
          const repo = ctx.resident(refs.repository(projectId));
          if (!repo) return;
          const next = new Map(), before = p.commits.values().next().value;
          for (const c of r.result.commits) {
            const old = p.commits.get(c.sha);
            const data = commitData(projectId, { ...c, ...(old ? { author: old.state.author, files: old.state.files } : {}) },
              { branch: repo.links.currentBranch ?? null, thread: committedFrom.get(c.sha) ?? null });
            ctx.safe('commit', () => ctx.handle.put(data.ref, { state: data.state, links: data.links }));
            next.set(c.sha, data);
          }
          for (const [sha, data] of p.commits) if (!next.has(sha)) ctx.safe('commit removal', () => ctx.handle.remove(data.ref));
          const top = next.values().next().value;
          p.root = r.result.root;
          const added = top && !p.commits.has(top.state.id) && (!before || top.state.time > before.state.time);
          p.commits = next;
          if (p.heard && added && !made.has(top.ref.id)) ctx.emitEvent(refs.repository(projectId), 'committed');
          p.heard = true;
        } catch (e) { ctx.log.warn('history: the commits could not be read', { message: String(e?.message ?? e) }); }
        finally { p.finishedAt = now(); }
      } while (p.again && !disposed && ctx.serverUp());
    })().finally(() => { p.reading = null; });
    return p.reading;
  }
  const readAll = () => Promise.all(ctx.graph.list('GitRepository').filter((r) => r.ref.provider === refs.agent().provider).map((r) => read(r.ref.id)));

  function plan(op, instance, args) {
    if (disposed) return { no: refused('unavailable', 'history is disposed') };
    if (!ctx.serverUp()) return { no: ctx.DOWN };
    const set = instance.ref.type === 'ChangeSet' ? instance : null;
    const thread = set?.links.thread ? ctx.resident(set.links.thread) : null;
    const projectId = set ? thread?.links.project?.id : instance.ref.id;
    const project = projectId ? ctx.resident(refs.project(projectId)) : null;
    const repo = projectId ? ctx.resident(refs.repository(projectId)) : null;
    if (!project || !repo) return { no: refused('unavailable', 'the project has no local git repository') };
    const p = { projectId, project, repo, set, thread, cwd: project.state.location, root: projects.get(projectId)?.root };
    if (op === 'commit') {
      const message = args[0];
      if (message === undefined || (typeof message === 'string' && !message.trim())) return { no: noMessage() };
      if (typeof message !== 'string' || message.trim().length > 20_000) return { no: refused('invalid', 'give a commit message of at most 20000 characters') };
      p.message = message.trim();
      p.paths = set ? [...new Set(ctx.graph.referrers(set.ref, 'changeSet').filter((f) => f.ref.type === 'FileChange'
        && f.ref.provider === set.ref.provider && f.ref.id.startsWith(`${set.ref.id}:`)).map((f) => f.ref.id.slice(set.ref.id.length + 1)))] : args[1];
    } else p.paths = args[0];
    if ((op !== 'commit' || p.paths !== undefined) && (!validPaths(p.paths) || (!set && !p.paths.every(relative)))) return { no: refused('invalid', 'give a non-empty array of repository-relative file paths (at most 500)') };
    if (set && p.root) {
      const normalized = setPaths(p, p.root);
      if (normalized.no) return normalized;
      if (otherStaged(p, normalized.paths, p.root)) return { no: refused('unavailable', 'other changes are staged: commit or unstage them first') };
    }
    return p;
  }

  function setPaths(p, root) {
    const paths = p.paths.map((f) => path.isAbsolute(f) ? path.relative(root, f) : f);
    if (!paths.every((f) => f.length && relative(f))) return { no: refused('unavailable', 'the changes include a file outside the repository') };
    return { paths };
  }
  function otherStaged(p, paths, root) {
    const wanted = new Set(paths);
    return p.repo.state.staged.some((f) => !wanted.has(path.isAbsolute(f) ? path.relative(root, f) : f));
  }
  async function mainOp(op, args) {
    const r = await ctx.mainOp(op, args);
    if (r.ok) return { result: r.result };
    if (r.refused) return { no: refused('unavailable', r.error) };
    throw new Error(r.error);
  }
  const timer = setInterval(() => { readAll(); }, 60_000);
  timer.unref?.();

  return {
    read,
    start: readAll,
    serverUp: readAll,
    observe(ref, concept) {
      if (concept !== 'Commit') return undefined;
      const id = ref.id.slice(0, ref.id.lastIndexOf(':')), p = projects.get(id);
      return p?.reading ?? (now() - (p?.finishedAt ?? -Infinity) > 30_000 ? read(id) : Promise.resolve());
    },
    prompt(op, instance, args) {
      const p = plan(op, instance, args);
      if (p.no) return null;
      const root = p.root ?? p.cwd;
      const name = p.project.state.name, title = p.thread?.state.title ?? 'New thread';
      const action = op !== 'commit' ? `${op} ${p.paths.length} files in “${name}”`
        : p.set ? `commit the changes of ${p.set.links.turn ? `a turn in “${title}”` : `“${title}”`}`
          : p.paths ? `commit ${p.paths.length} files in “${name}”` : `commit the changes in “${name}”`;
      return { action, detail: op === 'commit' ? `It makes a git commit in ${root} with the message “${p.message.split('\n')[0]}”.`
        : `It changes what the next commit in ${root} takes.` };
    },
    async run(op, instance, args) {
      const p = plan(op, instance, args);
      if (p.no) return p.no;
      if (p.set) {
        if (!p.root) { await read(p.projectId); p.root = projects.get(p.projectId)?.root; }
        if (!p.root) return refused('unavailable', 'the repository root could not be read');
        const normalized = setPaths(p, p.root);
        if (normalized.no) return normalized.no;
        p.paths = normalized.paths;
        const r = await mainOp('staged-elsewhere', { cwd: p.cwd, paths: p.paths });
        if (r.no) return r.no;
        if (r.result.length) return refused('unavailable', 'other changes are staged: commit or unstage them first');
      }
      let sha;
      try {
        const r = await mainOp(op, { cwd: p.cwd, ...(op === 'commit' ? { message: p.message, ...(p.paths !== undefined ? { paths: p.paths } : {}) } : { paths: p.paths }) });
        if (r.no) return r.no;
        if (op === 'commit') {
          sha = r.result.commitSha;
          if (p.thread) committedFrom.set(sha, p.thread.ref);
          made.add(refs.commit(p.projectId, sha).id);
        }
      } finally {
        await ctx.readRepository(p.projectId);
        await read(p.projectId);
      }
      if (op !== 'commit') return null;
      ctx.emitEvent(refs.repository(p.projectId), 'committed');
      if (p.set) ctx.emitEvent(p.set.ref, 'committed');
      return refs.commit(p.projectId, sha);
    },
    dispose() { disposed = true; clearInterval(timer); },
  };
}
