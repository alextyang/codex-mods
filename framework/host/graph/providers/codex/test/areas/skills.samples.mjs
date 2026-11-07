// Every branch of Skill's data (breadth step D10), for realizes.test.mjs.
import { skillData, librarySkillData } from '../../areas/skills.mjs';

export function produced() {
  return [
    skillData({ path: '/skills/user/SKILL.md', name: 'user', description: 'User skill', scope: 'user', enabled: true }),
    skillData({ path: '/skills/system/SKILL.md', name: 'system', description: 'System skill', shortDescription: 'Short', scope: 'system', enabled: false }),
    skillData({ path: '/repo/.codex/skills/repo/SKILL.md', name: 'repo', scope: 'repo' }, { projectId: 'p' }),
    skillData({ path: '/elsewhere/SKILL.md', name: 'unassigned', description: '', scope: 'repo', enabled: false }),
    skillData({ path: '/plugin/SKILL.md', name: 'plug:skill', scope: 'admin', enabled: true, pluginId: 'plug@library' }),
    librarySkillData({ id: 'one', name: 'one', description: 'Library skill' }),
    librarySkillData({ id: 'two', name: 'two', description: 'Long', shortDescription: 'Short' }),
    librarySkillData({ id: 'three', name: 'three' }),
  ];
}
