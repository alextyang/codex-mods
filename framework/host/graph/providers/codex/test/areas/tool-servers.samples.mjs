// Every data branch of the MCP area, including each relation it puts (realizes.test.mjs).
import { toolServerData, toolData } from '../../areas/tool-servers.mjs';
import { refs } from '../../map.mjs';

export function produced() {
  return [
    toolServerData('local', { command: 'node', enabled: false }, null, { readOnly: false, source: 'user' }),
    toolServerData('remote', { url: 'https://tools.example.com' }, { runtimeStatus: 'starting', authStatus: 'notLoggedIn' }, { source: 'project' }),
    toolServerData('codex_apps', null, { httpOrigin: 'https://apps.example.com', runtimeStatus: 'connected', authStatus: 'oAuth', pluginId: 'apps@market' }, { readOnly: true, account: refs.chatgptAccount('a'), source: 'plugin' }),
    toolServerData('injected', null, null),
    ...['notStarted', 'connected', 'authenticationRequired', 'failed', 'cancelled', 'disabled'].map((runtimeStatus) => toolServerData(runtimeStatus, { command: 'node' }, { runtimeStatus, authStatus: 'bearerToken', toolsError: 'discovery failed' })),
    toolServerData('fallback-error', null, { toolsError: 'discovery failed', authStatus: 'unknown' }),
    toolServerData('fallback-tools', null, { tools: { read: {} }, toolsError: '', authStatus: 'unsupported' }),
    toolData('local', 'description', { description: 'Description', title: 'Title' }, { enabled: true }),
    toolData('remote', 'title', { description: null, title: 'Title' }, { enabled: false, pluginId: 'p@market' }),
    toolData('local', 'empty', {}, { enabled: false }),
  ];
}
