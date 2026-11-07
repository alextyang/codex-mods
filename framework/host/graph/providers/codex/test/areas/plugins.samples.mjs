import { pluginData } from '../../areas/plugins.mjs';

export function produced() {
  const local = { name: 'local', path: '/tmp/plugins' }, remote = { name: 'remote' };
  return [
    pluginData({ id: 'alpha@local', name: 'alpha', installed: true, enabled: true, interface: { displayName: 'Alpha', shortDescription: 'Tools' } }, local),
    pluginData({ id: 'beta@local', name: 'beta', installed: false, enabled: true }, local),
    pluginData({ id: 'gamma@remote', name: 'gamma', installed: true, enabled: false, interface: { displayName: '', shortDescription: '' } }, remote, { connected: false }),
    pluginData({ id: 'delta@remote', name: 'delta', installed: true, enabled: true }, remote, { connected: true }),
  ];
}
