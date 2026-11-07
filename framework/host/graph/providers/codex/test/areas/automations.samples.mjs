// Automation's data branches and the links the feed adds to resident runs and the App (breadth step D9).
import { automationData } from '../../areas/automations.mjs';
import { refs } from '../../map.mjs';

export function produced() {
  return [
    automationData({ id: 'cron', kind: 'cron', name: 'Daily', prompt: 'Check', status: 'ACTIVE', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', projectId: 'p', lastRunAt: 1_700_000_000_000, nextRunAt: 1_700_086_400_000 }),
    automationData({ id: 'heartbeat', kind: 'heartbeat', name: 'Watch', status: 'PAUSED', rrule: 'FREQ=MINUTELY;INTERVAL=5', targetThreadId: 'watched', lastRunAt: null, nextRunAt: null }),
    automationData({ id: 'once', name: 'Once', prompt: '', status: 'ACTIVE', rrule: 'FREQ=DAILY;COUNT=1', lastRunAt: 0, nextRunAt: 0 }),
    automationData({ id: 'hourly', name: 'Hourly', status: 'PAUSED', rrule: 'FREQ=HOURLY' }),
    automationData({ id: 'weekly', name: 'Weekly', status: 'ACTIVE', rrule: 'FREQ=WEEKLY;BYDAY=MO,FR' }),
    automationData({ id: 'unknown', name: 'Other', status: 'DELETED' }),
    { ref: refs.turn('first'), state: {}, links: { automation: refs.automation('cron') } },
    { ref: refs.app(), state: {}, links: { automations: [refs.automation('cron'), refs.automation('heartbeat')] } },
  ];
}
