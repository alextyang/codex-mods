// The fake app-server's skills (breadth step D10):
//   skills/list {cwds?, forceReload?} -> {data: [{cwd, skills, errors: []}]}: the global skills and that cwd's repo skills, one entry per
//     requested cwd (none: the fake's cwd). Every skill is a SkillMetadata; defaults are one enabled user skill and one system skill.
//   skills/config/write {path | name, enabled} -> {effectiveEnabled}: changes the matching skill in every cwd; unknown is error -32600.
//   skills/extraRoots/set {extraRoots} -> {}: replaces the extra skill roots (absolute paths); fake/extraRoots {} -> {extraRoots}: the roots set.
//   Test controls: fake/skills {skills: [{cwd?, ...SkillMetadata}]} replaces the state; fake/skillsChanged {} sends skills/changed {}.
export default function skills(f) {
  let state = [
    { name: 'alpha', description: 'Alpha skill', shortDescription: null, path: '/tmp/fake-home/skills/alpha/SKILL.md', scope: 'user', enabled: true, interface: null, dependencies: null, pluginId: null },
    { name: 'system', description: 'System skill', shortDescription: null, path: '/tmp/fake-system/skills/system/SKILL.md', scope: 'system', enabled: true, interface: null, dependencies: null, pluginId: null },
  ];
  let extraRoots = [];
  return {
    'skills/extraRoots/set': (m, p) => {
      if (!Array.isArray(p.extraRoots) || p.extraRoots.some((r) => typeof r !== 'string' || !r.startsWith('/'))) return f.fail(m.id, -32602, 'Invalid params: extraRoots');
      extraRoots = [...p.extraRoots];
      return f.reply(m.id, {});
    },
    'fake/extraRoots': (m) => f.reply(m.id, { extraRoots }),
    'skills/list': (m, p) => {
      if (p.cwds !== undefined && (!Array.isArray(p.cwds) || p.cwds.some((cwd) => typeof cwd !== 'string'))) return f.fail(m.id, -32602, 'Invalid params: cwds');
      if (p.forceReload !== undefined && typeof p.forceReload !== 'boolean') return f.fail(m.id, -32602, 'Invalid params: forceReload');
      const cwds = p.cwds?.length ? p.cwds : [f.cwdOf({})];
      return f.reply(m.id, { data: cwds.map((cwd) => ({ cwd, skills: state.filter((s) => s.scope !== 'repo' || (s.cwd ?? f.cwdOf({})) === cwd).map(({ cwd: _cwd, ...meta }) => meta), errors: [] })) });
    },
    'skills/config/write': (m, p) => {
      if (typeof p.enabled !== 'boolean' || (typeof p.path !== 'string' && typeof p.name !== 'string')) return f.fail(m.id, -32602, 'Invalid params: path or name and enabled are needed');
      const matches = state.filter((s) => typeof p.path === 'string' ? s.path === p.path : s.name === p.name);
      if (!matches.length) return f.fail(m.id, -32600, `skill not found: ${p.path ?? p.name}`);
      for (const s of matches) s.enabled = p.enabled;
      return f.reply(m.id, { effectiveEnabled: p.enabled });
    },
    'fake/skills': (m, p) => {
      if (!Array.isArray(p.skills)) return f.fail(m.id, -32602, 'Invalid params: skills must be a list');
      state = structuredClone(p.skills);
      return f.reply(m.id, {});
    },
    'fake/skillsChanged': (m) => { f.reply(m.id, {}); f.notify('skills/changed', {}); },
  };
}
