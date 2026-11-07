import { threadSettingsData } from '../../areas/thread-settings.mjs';
import { modelData } from '../../map.mjs';

export function produced() {
  return threadSettingsData('t', {
    model: 'm', effort: 'medium', sandbox: 'workspaceWrite',
    collaborationMode: { mode: 'plan', settings: { model: 'm', reasoning_effort: 'medium', developer_instructions: null } },
  }, [modelData({ model: 'm', displayName: 'Model', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] })]);
}
