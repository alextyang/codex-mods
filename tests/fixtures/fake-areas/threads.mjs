// The fake app-server's extra Thread methods (breadth step D5; the core models send, steer, stop, archive, fork, compact and goals):
//   thread/unarchive {threadId} → {thread}, then thread/unarchived {threadId}.
//   thread/settings/update {threadId, ...updates} → {}, then thread/settings/updated {threadId, threadSettings}. Each thread starts with
//     schema-valid defaults; updates merge into its settings (null serviceTier clears it). `permissions` selects activePermissionProfile.
//   thread/backgroundTerminals/clean {threadId} → {}.
//   Test control: fake/threadSettings {threadId} → {params, threadSettings}, the last update's parameters (null before an update) and the
//     current settings. Settings are kept separately for each thread, including threads created by the core's start, resume and fork.
export default function threads(f) {
  const settings = new Map(), updates = new Map();
  function settingsOf(thread) {
    if (!settings.has(thread.id)) settings.set(thread.id, {
      model: 'fake', modelProvider: 'openai', cwd: thread.cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      collaborationMode: { mode: 'default', settings: { model: 'fake', reasoning_effort: null, developer_instructions: null } },
      effort: null, serviceTier: null, summary: null, personality: null, disabledPluginIds: [], multiAgentMode: 'explicitRequestOnly', activePermissionProfile: null,
    });
    return settings.get(thread.id);
  }
  return {
    'thread/unarchive': (m, p) => {
      const thread = f.threadFor(m, p); if (!thread) return;
      settingsOf(thread);
      thread.archived = false;
      f.reply(m.id, { thread });
      f.notify('thread/unarchived', { threadId: thread.id });
    },
    'thread/settings/update': (m, p) => {
      const thread = f.threadFor(m, p); if (!thread) return;
      const current = settingsOf(thread);
      for (const [key, value] of Object.entries(p)) {
        if (key === 'threadId') continue;
        if (key === 'permissions') {
          if (typeof value === 'string') current.activePermissionProfile = { id: value, extends: null };
        } else if (value !== null || ['effort', 'serviceTier', 'summary', 'personality'].includes(key)) current[key] = value;
      }
      updates.set(thread.id, structuredClone(p));
      f.reply(m.id, {});
      f.notify('thread/settings/updated', { threadId: thread.id, threadSettings: current });
    },
    'thread/backgroundTerminals/clean': (m, p) => {
      const thread = f.threadFor(m, p); if (!thread) return;
      settingsOf(thread);
      f.reply(m.id, {});
    },
    'fake/threadSettings': (m, p) => {
      const thread = f.threadFor(m, p); if (!thread) return;
      f.reply(m.id, { params: updates.get(thread.id) ?? null, threadSettings: settingsOf(thread) });
    },
  };
}
