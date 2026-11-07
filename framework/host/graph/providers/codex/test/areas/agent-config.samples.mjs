import { configSettingData } from '../../areas/agent-config.mjs';
import { refs } from '../../map.mjs';

export function produced() {
  return [
    configSettingData('web_search', 'cached', { scope: 'app' }),
    configSettingData('sandbox_workspace_write.network_access', false, { scope: 'project', projectId: 'p' }),
    { ref: refs.agent(), state: {}, links: { settings: [], instructions: [], skills: [], toolServers: [], plugins: [] } },
  ];
}
