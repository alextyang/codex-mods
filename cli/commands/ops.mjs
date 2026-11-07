// codexmods ops get|list|wait <opId>
import { UsageError, contextFor, err, out, parse, printJson, splitFirst } from '../lib/args.mjs';
import { EXIT, guarded, withHost } from '../lib/run.mjs';
import { waitForOp } from '../lib/client.mjs';
import { opOutcomeText, table } from '../lib/format.mjs';

export const USAGE = `codexmods ops <subcommand>

  get <opId>              show one operation
  list [--mod <modId>] [--running]
  wait <opId>             follow until the operation ends; exit 0 if it succeeded, 1 otherwise

Options: --root <dir> --profile <name> --json`;

export async function run(argv, io) {
  return guarded(io, async () => {
    const { first: sub, rest } = splitFirst(argv);
    if (!sub || sub === 'help') {
      const help = sub === 'help' || rest.includes('--help') || rest.includes('-h');
      out(io, USAGE);
      return help ? EXIT.ok : EXIT.usage;
    }
    const { values, positionals } = parse(rest, { mod: { type: 'string' }, running: { type: 'boolean' } });
    if (values.help) { out(io, USAGE); return EXIT.ok; }
    const ctx = contextFor(io, values);
    switch (sub) {
      case 'get': {
        if (positionals.length !== 1) throw new UsageError('usage: codexmods ops get <opId>');
        return withHost(ctx, async (c) => {
          const op = await c.call('ops.get', { opId: positionals[0] });
          if (values.json) printJson(io, op); else out(io, opOutcomeText(op) + (op.phases.length ? `\n  phases: ${op.phases.map((p) => p.name).join(' > ')}` : ''));
          return EXIT.ok;
        });
      }
      case 'list': {
        if (positionals.length !== 0) throw new UsageError('usage: codexmods ops list [--mod <modId>] [--running]');
        return withHost(ctx, async (c) => {
          const { ops } = await c.call('ops.list', { ...(values.mod ? { modId: values.mod } : {}), ...(values.running ? { running: true } : {}) });
          if (values.json) { printJson(io, { ops }); return EXIT.ok; }
          if (ops.length === 0) { out(io, 'No operations.'); return EXIT.ok; }
          out(io, table(ops, [
            { title: 'OP', get: (o) => o.id }, { title: 'TYPE', get: (o) => o.input.type },
            { title: 'TARGET', get: (o) => o.input.modId ?? '' }, { title: 'OUTCOME', get: (o) => o.outcome },
            { title: 'STARTED', get: (o) => o.startedAt },
          ]));
          return EXIT.ok;
        });
      }
      case 'wait': {
        if (positionals.length !== 1) throw new UsageError('usage: codexmods ops wait <opId>');
        return withHost(ctx, async (c) => {
          const op = await waitForOp(c, positionals[0], {
            onProgress: values.json ? undefined : (o) => { if (o.outcome === 'running' && o.phases.length) out(io, `  ${o.phases.at(-1).name}...`); },
          });
          if (values.json) printJson(io, op); else out(io, opOutcomeText(op));
          return op.outcome === 'succeeded' ? EXIT.ok : EXIT.failed;
        });
      }
      default:
        err(io, `codexmods ops: unknown subcommand "${sub}"\n\n${USAGE}`);
        return EXIT.usage;
    }
  });
}

