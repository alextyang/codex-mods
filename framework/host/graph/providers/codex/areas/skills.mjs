// Skills in the native provider (breadth step D10): installed skills from the app-server and the app's recommended library. Writes use
// the app's own config and recommendedSkills service, then invalidate its pages and read again. A mod's lasting changes ask first (R17).
// CodexAgent.addSkill (public-hooks.md §3.16, H9b; scout H9b-skills): the app's "New skill" only starts a chat with its skill-creator, which
// writes the files, so a skill is made as that writes one: `<name>/SKILL.md` (frontmatter name and description, then the text) in the
// Codex home's `skills` folder, or a project's `.codex/skills` (where the app installs and deletes a project's), by framework-main
// (`add-skill`: each folder made exclusively, none of them a link, SKILL.md never written over); then the skills are read with
// forceReload and the app's pages refreshed. A mod's call asks the user, naming the folder; the write goes only to that one.
import path from 'node:path';
import { refs } from '../map.mjs';

export const realizes = {
  types: ['Skill'],
  operations: { Skill: ['enable', 'disable', 'delete', 'install', 'edit'], CodexAgent: ['addSkill'] },
  supports: { CodexAgent: ['addSkill'] },
  events: { Skill: ['added', 'changed', 'removed'] },
  links: { Skill: ['project', 'agents', 'plugin'] },
};

/** One installed skill, by its path, and the project whose cwd listed it. */
export function skillData(meta, { projectId } = {}) {
  return {
    ref: refs.skill(meta.path),
    state: {
      name: meta.name, description: meta.shortDescription || meta.description || '',
      scope: meta.scope === 'repo' ? 'project' : 'global',
      source: meta.scope === 'system' ? 'builtIn' : meta.pluginId ? 'library' : 'yours',
      installed: true, enabled: meta.enabled === true,
    },
    links: {
      agents: [refs.agent()],
      ...(meta.scope === 'repo' && projectId != null ? { project: refs.project(projectId) } : {}),
      ...(meta.pluginId ? { plugin: refs.plugin(meta.pluginId) } : {}),
    },
  };
}

/** A skill from the app's library that has no global installation. */
export function librarySkillData(entry) {
  return {
    ref: refs.skill(`library:${entry.id}`),
    state: { name: entry.name, description: entry.shortDescription || entry.description || '', scope: 'global', source: 'library', installed: false, enabled: false },
    links: { agents: [] },
  };
}

export function types(feed) {
  return {
    Skill: { operations: {
      enable: { effect: 'external', approval: ({ instance }) => feed().prompt('enable', instance), handler: ({ ref, intent }) => feed().enable(ref, intent) },
      disable: { effect: 'external', approval: ({ instance }) => feed().prompt('disable', instance), handler: ({ ref, intent }) => feed().disable(ref, intent) },
      delete: { effect: 'external', approval: ({ instance }) => feed().prompt('delete', instance), handler: ({ ref }) => feed().delete(ref) },
      install: { effect: 'external', approval: ({ instance }) => feed().prompt('install', instance), handler: ({ ref }) => feed().install(ref) },
      edit: { effect: 'none', handler: ({ ref }) => feed().edit(ref) },
    } },
    // a skill of the user's own, written as the app's skill-creator writes one (a mod's asks first): its Skill once Codex lists it
    CodexAgent: { operations: {
      addSkill: { effect: 'external', approval: ({ args }) => feed().promptAdd(args[0]), handler: ({ args }) => feed().addSkill(args[0]) },
    } },
  };
}

/** A skill's name, as the app's skill-creator validates it: lowercase letters, digits, single hyphens between them; at most 64. */
const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SKILL_MAX = 1_048_576;   // bytes of SKILL.md, as the app reads one
/** SKILL.md for a spec: its frontmatter (the description as a quoted YAML string), then the text. */
export const skillFile = ({ name, description, text }) => `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${text.replace(/\s+$/, '')}\n`;

export function createFeed(ctx) {
  const now = ctx.now ?? Date.now;
  let known = new Map(); // path (or library:<id>) -> {data, meta? , entry?}, only this area's instances
  let reading = null, again = false, reload = false, timer = null, disposed = false, heard = false, finishedAt = -Infinity;
  const refused = (reason, message) => ({ status: 'refused', reason, message });

  function projectOf(cwd, projects) {
    let id = null, length = -1;
    for (const p of projects) for (const r of p.roots) {
      const root = path.resolve(r), dir = path.resolve(cwd);
      if ((dir === root || dir.startsWith(root === '/' ? '/' : `${root}/`)) && root.length > length) { id = p.id; length = root.length; }
    }
    return id;
  }

  async function library() {
    try {
      const r = await ctx.mainOp('library', {});
      if (!r.ok || r.result?.error) throw new Error(r.error ?? r.result?.error ?? 'the library could not be read');
      return r.result?.skills ?? [];
    } catch (e) {
      ctx.log.warn('skills: the library could not be read', { message: String(e?.message ?? e) });
      return [];
    }
  }

  /** Coalesce overlapping reads into the running promise and one further read; preserve a queued forceReload. */
  function read({ forceReload = false } = {}) {
    if (disposed || !ctx.serverUp()) return Promise.resolve();
    reload ||= forceReload;
    if (reading) { again = true; return reading; }
    reading = (async () => {
      do {
        const force = reload;
        again = false; reload = false;
        try {
          const projects = ctx.appProjects?.list() ?? [];
          const cwds = [...new Set(projects.flatMap((p) => p.roots))];
          const r = await ctx.request('skills/list', { cwds, forceReload: force });
          if (disposed) return;
          const entries = await library();
          if (disposed) return;
          const next = new Map();
          const installed = new Set();
          for (const row of r.data) for (const meta of row.skills) {
            const data = skillData(meta, { projectId: projectOf(row.cwd, projects) });
            const prior = next.get(data.ref.id);
            if (!prior || (!prior.data.links.project && data.links.project)) next.set(data.ref.id, { data, meta });
            if (data.state.scope === 'global') installed.add(meta.name);
          }
          for (const entry of entries) if (!installed.has(entry.name)) {
            const data = librarySkillData(entry);
            next.set(data.ref.id, { data, entry });
          }
          for (const [id, { data }] of next) {
            const before = known.get(id)?.data;
            ctx.safe('skill', () => ctx.handle.put(data.ref, { state: data.state, links: data.links }));
            if (heard && !before) ctx.emitEvent(data.ref, 'added');
            else if (heard && JSON.stringify(before.state) !== JSON.stringify(data.state)) ctx.emitEvent(data.ref, 'changed');
          }
          for (const [id, { data }] of known) if (!next.has(id)) {
            if (heard) ctx.emitEvent(data.ref, 'removed');
            ctx.safe('skill removal', () => ctx.handle.remove(data.ref));
          }
          known = next;
          heard = true;
        } catch (e) { ctx.log.warn('skills: the skills could not be read', { message: String(e?.message ?? e) }); }
        finally { finishedAt = now(); }
      } while (again && !disposed && ctx.serverUp());
    })().finally(() => { reading = null; });
    return reading;
  }

  function schedule(forceReload = false) {
    if (disposed) return;
    reload ||= forceReload;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; read(); }, 500);
    timer.unref?.();
  }

  async function refresh() {
    try {
      const r = await ctx.mainOp('refresh', { keys: [['skills'], ['recommendedSkills']] });
      if (!r.ok || r.result?.error) throw new Error(r.error ?? r.result?.error ?? 'the pages could not be refreshed');
    } catch (e) { ctx.log.warn('skills: the pages could not be refreshed', { message: String(e?.message ?? e) }); }
    await read({ forceReload: true });
  }

  /**
   * CodexAgent.addSkill's spec checked: `{name, description, text, project?}` -> what it writes, or a refusal. `now` (the handler's): also
   * against the skills there now; the approval asks about every valid spec (a duplicate is refused after, so no call goes unasked).
   */
  function addition(spec, now = true) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return refused('invalid', 'a skill is {name, description, text, project?}');
    const { name, description, text, project } = spec;
    if (typeof name !== 'string' || name.length > 64 || !SKILL_NAME.test(name)) return refused('invalid', 'a skill\'s name is lowercase letters, digits and single hyphens (at most 64)');
    if (typeof description !== 'string' || !description.trim() || description.length > 1024 || /[<>\r\n]/.test(description)) return refused('invalid', 'a skill\'s description is one line of 1 to 1024 characters, without < or >');
    if (typeof text !== 'string' || !text.trim()) return refused('invalid', 'a skill needs its text (what the agent follows)');
    const file = skillFile({ name, description: description.trim(), text });
    if (Buffer.byteLength(file) > SKILL_MAX) return refused('invalid', 'a skill\'s SKILL.md is at most 1 MB');
    let root = null;
    if (project !== undefined && project !== null) {
      const p = project?.provider === refs.agent().provider ? (ctx.appProjects?.list() ?? []).find((x) => x.id === project.id) : null;
      if (!p) return refused('invalid', 'project is one of the app\'s projects');
      root = p.roots?.[0] ? path.resolve(p.roots[0]) : null;
      if (!root) return refused('unavailable', 'the project has no folder');
    }
    if (now) for (const { data } of known.values()) if (data.state.installed && data.state.name === name && (root ? data.links.project?.id === project.id : data.state.scope === 'global')) {
      return refused('invalid', `there is a skill “${name}” already: edit it`);
    }
    return { name, root, file, projectId: root ? project.id : null };
  }
  let home = null;   // the Codex home, once framework-main said it
  const asked = new Map();   // a spec the user was asked about -> the folder they were told (a project's root, or 'home'), until its call
  async function codexHome() {
    if (home) return home;
    const r = await ctx.appProjects?.op('instructions', null);
    if (r?.ok && typeof r.result?.home === 'string' && path.isAbsolute(r.result.home)) home = path.resolve(r.result.home);
    return home;
  }

  function unsupported(op, instance) {
    if (!instance.state.installed) return refused('unsupported', 'the library skill is not installed');
    if (op === 'delete') {
      if (instance.state.source === 'builtIn') return refused('unsupported', "Codex's own skill");
      if (instance.links.plugin) return refused('unsupported', `it comes with the plugin ${instance.links.plugin.id}: uninstall the plugin`);
    }
    return null;
  }

  async function appOp(op, args) {
    const r = await ctx.mainOp(op, args);
    if (!r.ok) {
      if (r.refused) return refused('unavailable', r.error);
      throw new Error(r.error);
    }
    if (r.result?.success === false) throw new Error(r.result.error ?? 'the app could not do it');
    return null;
  }

  async function setEnabled(ref, enabled, intent) {
    if (!ctx.serverUp()) return ctx.DOWN;
    const instance = ctx.resident(ref);
    const no = unsupported(enabled ? 'enable' : 'disable', instance);
    if (no) return no;
    if (instance.state.enabled === enabled) return null;
    const selector = instance.state.name.includes(':') ? { name: instance.state.name } : { path: ref.id };
    await ctx.request('skills/config/write', { ...selector, enabled }, intent);
    await refresh();
    return null;
  }

  const sub = ctx.appProjects?.onChange(() => { read(); });
  return {
    read,
    /**
     * The app's own request as a Skill operation, for the graph to hold (public-hooks.md §3.5, H6m): a skill turned on or off, by its path
     * or (a plugin's skill) by its name. Null: not one (or a skill this area does not know).
     */
    appOperation(method, p) {
      if (method !== 'skills/config/write' || typeof p.enabled !== 'boolean') return null;
      const op = p.enabled ? 'enable' : 'disable';
      if (typeof p.path === 'string' && p.path) return known.has(p.path) ? { ref: refs.skill(p.path), operation: op, args: [] } : null;
      if (typeof p.name !== 'string' || !p.name) return null;
      // by its name: the one skill that has it; two that share it are refused while something holds it (built review H6m1)
      const named = [...known].filter(([, { data }]) => data.state?.name === p.name && data.state.installed);
      if (named.length > 1) return { refuse: `more than one skill is named ${p.name}`, type: 'Skill', operation: op };
      return named.length ? { ref: refs.skill(named[0][0]), operation: op, args: [] } : null;
    },
    // the Codex home is read then too, so a mod's addSkill names its folder when the user is asked
    start: () => { void codexHome().catch(() => {}); return read(); },
    serverUp: () => read(),
    notified(method) { if (method === 'skills/changed') schedule(true); },
    responded(method) { if (['skills/config/write', 'plugin/install', 'plugin/uninstall'].includes(method)) schedule(); },
    observe(_ref, concept) {
      if (concept !== 'Skill') return undefined;
      return reading ?? (now() - finishedAt > 30_000 ? read() : Promise.resolve());
    },
    prompt(op, instance) {
      if (!ctx.serverUp()) return null;
      if (op === 'install') {
        if (instance.state.installed) return null;
        return { action: `install the skill “${instance.state.name}”`, detail: "It is copied from OpenAI's skills library into your Codex home." };
      }
      if (unsupported(op, instance)) return null;
      if (op === 'enable' || op === 'disable') {
        if (instance.state.enabled === (op === 'enable')) return null;
        return { action: `turn ${op === 'enable' ? 'on' : 'off'} the skill “${instance.state.name}”`, detail: "Codex's config.toml records it: new threads use it." };
      }
      if (op === 'delete') return { action: `delete the skill “${instance.state.name}”`, detail: 'Its folder is deleted from this Mac.' };
      return null;
    },
    enable: (ref, intent) => setEnabled(ref, true, intent),
    disable: (ref, intent) => setEnabled(ref, false, intent),
    async delete(ref) {
      if (!ctx.serverUp()) return ctx.DOWN;
      const no = unsupported('delete', ctx.resident(ref));
      if (no) return no;
      const result = await appOp('remove', { skillPath: ref.id });
      if (result) return result;
      await refresh();
      return null;
    },
    async install(ref) {
      if (!ctx.serverUp()) return ctx.DOWN;
      if (ctx.resident(ref).state.installed) return null;
      const entry = known.get(ref.id).entry;
      const result = await appOp('install', { skillId: entry.id, repoPath: entry.repoPath });
      if (result) return result;
      await refresh();
      return null;
    },
    /** What the user is asked before a mod's CodexAgent.addSkill (R17), or null when it will be refused. */
    promptAdd(spec) {
      const a = addition(spec, false);
      if (a.status === 'refused') return null;
      asked.delete(JSON.stringify(spec));
      asked.set(JSON.stringify(spec), a.root ?? 'home');
      if (asked.size > 64) asked.delete(asked.keys().next().value);
      return { action: `add the skill “${a.name}”`, detail: a.root ? `Codex will use it in the chats of the project at ${a.root}: it is written to ${a.root}/.codex/skills/${a.name}.`
        : `Codex will use it in every chat, here and in the command line: it is written to your Codex home's skills folder${home ? ` (${home}/skills/${a.name})` : ''}.` };
    },
    /** CodexAgent.addSkill(spec): SKILL.md written in a new folder of the skills folder; the Skill once Codex lists it. */
    async addSkill(spec) {
      if (!ctx.serverUp()) return ctx.DOWN;
      const a = addition(spec);
      const key = JSON.stringify(spec), told = asked.get(key);
      asked.delete(key);
      if (a.status === 'refused') return a;
      // the user was told another folder (the project's changed since): not written anywhere
      if (told !== undefined && told !== (a.root ?? 'home')) return refused('unavailable', 'the project\'s folder changed since you were asked: nothing was written');
      const h = a.root ? null : await codexHome();
      const expected = a.root ? path.join(a.root, '.codex', 'skills', a.name, 'SKILL.md') : h ? path.join(h, 'skills', a.name, 'SKILL.md') : null;
      const r = await ctx.appProjects?.op('add-skill', a.projectId, { name: a.name, text: a.file }) ?? { ok: false, refused: true, error: 'the app\'s projects are not available' };
      if (!r.ok && r.refused) return refused(/there already|not a folder of its own/.test(String(r.error)) ? 'invalid' : 'unavailable', r.error);
      await refresh();
      if (r.ok) return refs.skill(typeof r.result?.path === 'string' ? r.result.path : expected);
      // framework-main did not say (its answer came too late): a skill Codex lists there now says, else the outcome is not known
      return expected && ctx.resident(refs.skill(expected)) ? refs.skill(expected) : { status: 'uncertain', operation: 'addSkill' };
    },
    async edit(ref) {
      if (!ctx.serverUp()) return ctx.DOWN;
      const no = unsupported('edit', ctx.resident(ref));
      if (no) return no;
      return appOp('open', { path: ref.id.endsWith('/SKILL.md') ? ref.id : `${ref.id.replace(/\/+$/, '')}/SKILL.md` });
    },
    dispose() { disposed = true; clearTimeout(timer); sub?.dispose(); },
  };
}
