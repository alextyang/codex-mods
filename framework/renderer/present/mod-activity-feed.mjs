// A mod's Activity (docs/design/framework-ui.md F9; design-spec §2.5): what it logged and what the framework did to it, since Codex started. It reads `Mod.activity` with a cursor and reads
// again when the mod's `activity` event says there is more; it says when lines were dropped; errors can be shown alone; and the log can be copied as text. Theme variables only. NO NODE API.
import { timeOf, dayOf, text } from './mods-text.mjs';

/** The most lines kept while the page is open: the newest. */
export const FEED_LINES = 1000;
/** What Copy log copies. */
export const logText = (lines) => lines.map((l) => `${timeOf(l.at)}  ${l.level}  ${l.message}`).join('\n');

/**
 * @param {{ R: object, kit: object, exports: () => object, invoke: (ref: object, op: string, args?: unknown[]) => Promise<object>, subscribe?: (query: object, fn: Function) => { dispose(): void } }} o
 */
export function createActivityFeed(o) {
  const { R, kit } = o;
  const e = R.createElement;

  /** @param {{ mod: object, name: string }} p  `mod`: the Mod's ref */
  function ActivityFeed({ mod, name }) {
    const ex = o.exports() ?? {};
    const { SettingsSection: Section } = ex;
    const [feed, setFeed] = R.useState({ lines: [], since: null, dropped: false });
    const [show, setShow] = R.useState('all');
    const [copied, setCopied] = R.useState(false);
    const cursor = R.useRef(null);
    const reading = R.useRef(false);
    const again = R.useRef(false);
    const read = async () => {
      if (reading.current) { again.current = true; return; }
      reading.current = true;
      try {
        const out = await o.invoke(mod, 'activity', [cursor.current ? { after: cursor.current } : {}]);
        const v = out?.status === 'done' || out?.status === undefined ? out?.value : null;
        if (v) {
          cursor.current = v.cursor ?? cursor.current;
          setFeed((f) => ({ lines: [...f.lines, ...(v.lines ?? [])].slice(-FEED_LINES), since: v.since ?? f.since, dropped: f.dropped || Boolean(v.dropped) }));
        }
      } catch { /* it says nothing new; the next event reads again */ } finally {
        reading.current = false;
        if (again.current) { again.current = false; void read(); }
      }
    };
    R.useEffect(() => {
      void read();
      const sub = o.subscribe?.({ ref: mod, depth: 'core' }, (m) => { if (m?.type === 'delta' && m.event?.kind === 'event' && m.event.name === 'activity') void read(); });
      return () => sub?.dispose?.();
    }, [mod.id]);
    const errors = feed.lines.some((l) => l.level === 'error');
    const lines = show === 'errors' && errors ? feed.lines.filter((l) => l.level === 'error') : feed.lines;
    const copy = async () => {
      try { await globalThis.navigator?.clipboard?.writeText?.(logText(lines)); setCopied(true); } catch { setCopied(false); }
    };
    const since = feed.since ? timeOf(feed.since) : '';
    const actions = e('span', { className: 'cmk-activity-actions' },
      errors ? e(kit.SegmentedControl, { options: [{ value: 'all', label: 'All' }, { value: 'errors', label: 'Errors' }], value: show, onChange: setShow, ariaLabel: 'Show' }) : null,
      e(kit.Action, { label: copied ? 'Copied' : 'Copy log', glyph: 'copy', onClick: copy, disabled: !lines.length }));
    return e(Section, null,
      e(Section.Header, { title: 'Activity', subtitle: since ? `Since Codex started at ${since}` : 'Since Codex started', actions }),
      e(Section.Content, null,
        e('div', { className: 'cmk-log', role: 'log', 'aria-label': `${name} activity` },
          feed.dropped ? e('div', { key: 'dropped', className: 'cmk-log-note' }, 'Some earlier lines were dropped.') : null,
          lines.length ? lines.map((l, i) => e('div', { key: `${l.at}:${i}`, className: 'cmk-log-line', 'data-level': l.level },
            e('span', { className: 'cmk-log-time' }, timeOf(l.at)), e('span', { className: 'cmk-log-level' }, l.level), e('span', { className: 'cmk-log-message' }, l.message)))
            : e('div', { key: 'none', className: 'cmk-log-note' }, 'No activity yet.'))));
  }

  /** What stopped it, which a restart does not lose (F9); the stack only with Developer mode on. */
  function lastFaultRows({ fault, faults, developer, Row }) {
    if (!fault) return [];
    const when = [dayOf(fault.at), timeOf(fault.at)].filter(Boolean).join(' ');
    return [
      e(Row, { key: 'fault', label: 'Last fault', description: e('span', { className: 'cmk-fault' }, `${text(fault.message)} (${text(fault.where)})`, faults > 0 ? e('span', { key: 'n' }, `${faults} since Codex started`) : null),
        control: e('span', { className: 'cmk-meta' }, when) }),
      ...(developer && fault.stack ? [e('pre', { key: 'stack', className: 'cmk-log cmk-stack-trace' }, text(fault.stack))] : []),
    ];
  }
  return { ActivityFeed, lastFaultRows };
}
