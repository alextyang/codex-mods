// SettingsPage (docs/graph/03): a page of the app's settings. On 21477 a page is a frame whose title is the settings title component,
// rendered with only the page's slug (`appearance`, `git-settings`, `usage`, ...); the frame carries no slug of its own, and the settings
// navigation's items use the same title component with more props, so the address is the title with exactly `slug`. The native provider's
// SettingsSection of the same slug holds the settings the page shows (pages that show no registry setting, such as Account, have none).
// It passes through. NO NODE API.
import { defineBinding } from '../runtime.mjs';

export const settingsPage = defineBinding({
  id: 'settings.page', presentation: 'SettingsPage',
  place: { in: 'Window', slot: 'main' },
  presents: ['SettingsSection'],
  subject(props) {
    const slug = props.slug;
    return typeof slug === 'string' && slug && Object.keys(props).length === 1 ? { type: 'SettingsSection', provider: 'codex', id: slug } : null;
  },
});
