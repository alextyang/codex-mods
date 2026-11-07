// codexmods features [--all] [--status <s>]: the feature log with the running build's status (docs/design/systems.md "E4 in detail")
import { UsageError, contextFor, err, out, parse, printJson } from '../lib/args.mjs';
import { EXIT, guarded, withHost } from '../lib/run.mjs';
import { table } from '../lib/format.mjs';

export const USAGE = `codexmods features [--all] [--status present|changed|missing|unknown]

  The features and mechanics of the framework's feature log, with their status on the running build of the app. By default only what
  is not present; --all lists everything, --status one status.

Options: --root <dir> --profile <name> --json`;

const STATUSES = new Set(['present', 'changed', 'missing', 'unknown']);

export async function run(argv, io) {
  return guarded(io, async () => {
    const { values, positionals } = parse(argv, { all: { type: 'boolean' }, status: { type: 'string' } });
    if (values.help) { out(io, USAGE); return EXIT.ok; }
    if (positionals.length) { err(io, USAGE); return EXIT.usage; }
    if (values.status !== undefined && !STATUSES.has(values.status)) throw new UsageError(`--status is one of ${[...STATUSES].join(', ')}`);
    const ctx = contextFor(io, values);
    return withHost(ctx, async (c) => {
      const list = await c.call('features.list', {});
      if (values.json) { printJson(io, list); return EXIT.ok; }
      if (!list.log) { out(io, 'This framework has no feature log.'); return EXIT.ok; }
      const all = [...list.features, ...list.mechanics];
      const counts = {};
      for (const x of all) counts[x.status] = (counts[x.status] ?? 0) + 1;
      out(io, `Build ${list.build ?? 'unknown'} · log ${list.log.hash} · ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`
        + `${list.evidence?.census ? '' : ' · no census for this build'}${list.evidence?.stale?.length ? ` · stale: ${list.evidence.stale.join(', ')}` : ''}`);
      const shown = all.filter((x) => (values.status ? x.status === values.status : values.all || x.status !== 'present'));
      if (!shown.length) { out(io, values.all || values.status ? 'None.' : 'Everything is present.'); return EXIT.ok; }
      out(io, table(shown, [
        { title: 'ID', get: (x) => x.id }, { title: 'STATUS', get: (x) => x.status },
        { title: 'WHY', get: (x) => (x.kind === 'mechanic' ? x.why : x.because?.[0] ? `${x.because[0].id}: ${x.because[0].why}` : '') },
      ]));
      return EXIT.ok;
    });
  });
}
