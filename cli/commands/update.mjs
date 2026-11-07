// codexmods update status|check|stage|apply [--anyway] [--consent <ids>]|later|policy <offer|auto>: the copy's update (docs/design/systems.md E5)
import { UsageError, contextFor, err, out, parse, printJson, splitFirst } from '../lib/args.mjs';
import { EXIT, guarded, withHost } from '../lib/run.mjs';
import { waitForOp } from '../lib/client.mjs';
import { opOutcomeText } from '../lib/format.mjs';

export const USAGE = `codexmods update <subcommand>

  status                  the offer, its staging, the plan with its verdict and risks, the policy
  check                   ask the stock app and the release source now
  stage                   prepare the offer now (in quarantine; nothing changes until you apply it)
  apply [--anyway] [--consent <id,id>] [--no-wait]
                          apply the plan (the app closes and reopens on the new copy); a held plan only with --anyway, which leaves
                          the mods at risk disabled; --consent lets mods whose new version asks for more permissions take it
  later                   keep the offer without asking again until it changes
  policy offer|auto       auto applies a ready plan at the next launch (never a held one)

Options: --root <dir> --profile <name> --json`;

function statusText(u) {
  const lines = [];
  if (!u.offer) lines.push('No update: this copy matches the installed ChatGPT and the framework is current.');
  else {
    lines.push(`Offer: ChatGPT ${u.offer.build}${u.offer.build !== u.offer.copyBuild ? ` (this copy: ${u.offer.copyBuild})` : ''}${u.offer.framework ? `, framework ${u.offer.framework.to} (now ${u.offer.framework.from})` : ''}${u.offer.dismissed ? ' (later)' : ''}`);
    if (u.staging) lines.push(`Staging: ${u.staging.step}`);
    if (u.problem) lines.push(`Could not be prepared: ${u.problem.problem}`);
    if (u.plan) {
      lines.push(`Plan ${u.plan.hash}: ${u.plan.held ? 'held' : 'ready'} (${u.plan.checked})`);
      for (const m of u.plan.mods ?? []) lines.push(`  ${m.id} ${m.from} -> ${m.to}`);
      for (const r of u.plan.risks ?? []) lines.push(`  at risk: ${r.mod}: ${r.sentences.join(' ') || r.status}`);
      for (const c of u.plan.consentNeeded ?? []) lines.push(`  needs consent: ${c.id} ${c.version} (${c.addedPermissions.join(', ')})`);
    }
  }
  lines.push(`Policy: ${u.policy ?? 'offer'}${u.unknown?.length ? ` · unknown: ${u.unknown.join('; ')}` : ''}`);
  return lines.join('\n');
}

export async function run(argv, io) {
  return guarded(io, async () => {
    const { first: sub, rest } = splitFirst(argv);
    if (!sub || sub === 'help') { out(io, USAGE); return sub === 'help' ? EXIT.ok : EXIT.usage; }
    const { values, positionals } = parse(rest, { anyway: { type: 'boolean' }, consent: { type: 'string' }, 'no-wait': { type: 'boolean' } });
    if (values.help) { out(io, USAGE); return EXIT.ok; }
    const ctx = contextFor(io, values);
    const show = (u) => { if (values.json) printJson(io, u); else out(io, statusText(u)); return EXIT.ok; };
    switch (sub) {
      case 'status': return withHost(ctx, async (c) => show(await c.call('updates.status', {})));
      case 'check': return withHost(ctx, async (c) => show(await c.call('updates.check', {})));
      case 'stage': return withHost(ctx, async (c) => { const r = await c.call('updates.stage', {}); if (r.problem && !values.json) err(io, `Could not be prepared: ${r.problem}`); return show(r); });
      case 'later': return withHost(ctx, async (c) => show(await c.call('updates.later', {})));
      case 'policy': {
        if (positionals.length !== 1 || !['offer', 'auto'].includes(positionals[0])) throw new UsageError('usage: codexmods update policy offer|auto');
        return withHost(ctx, async (c) => show(await c.call('updates.policy', { policy: positionals[0] })));
      }
      case 'apply': return withHost(ctx, async (c) => {
        const u = await c.call('updates.status', {});
        if (!u.plan) { err(io, 'No plan to apply: stage the update first (codexmods update stage).'); return EXIT.failed; }
        if (u.plan.held && !values.anyway) { err(io, `The update is held:\n${u.plan.risks.map((r) => `  ${r.mod}: ${r.sentences.join(' ') || r.status}`).join('\n')}\nApply it with --anyway to leave those mods disabled.`); return EXIT.failed; }
        const consent = values.consent ? values.consent.split(',').map((x) => x.trim()).filter(Boolean) : undefined;
        const { opId } = await c.call('updates.apply', { plan: u.plan.hash, ...(values.anyway ? { anyway: true } : {}), ...(consent ? { consent } : {}) });
        if (values['no-wait']) { if (values.json) printJson(io, { opId }); else out(io, `${opId}: applying; the app closes and reopens on the new copy`); return EXIT.ok; }
        let op;
        try { op = await waitForOp(c, opId, { until: (o) => /^switching/.test(o.note ?? '') }); } catch (e) {
          if (e?.code !== 'Unavailable') throw e;
          out(io, `${opId}: the app closed to switch to the new copy; \`codexmods update status\` once it is back`);
          return EXIT.ok;
        }
        if (values.json) printJson(io, op); else out(io, opOutcomeText(op));
        return op.outcome === 'running' || op.outcome === 'succeeded' ? EXIT.ok : EXIT.failed;
      });
      default:
        err(io, `codexmods update: unknown subcommand "${sub}"\n\n${USAGE}`);
        return EXIT.usage;
    }
  });
}
