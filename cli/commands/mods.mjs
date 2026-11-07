// codexmods mods list|inspect|install|consent|enable|disable|configure|update|rollback|remove|reattach|clear-quarantine|reload|permission|automatic|policy
import { UsageError, absPath, contextFor, err, out, parse, printJson, splitFirst } from '../lib/args.mjs';
import { EXIT, guarded, mutate, withHost } from '../lib/run.mjs';
import { ago, bytes, opSummary, table } from '../lib/format.mjs';

export const USAGE = `codexmods mods <subcommand>

  list                                  installed mods
  inspect <modId>                       permissions, versions, settings, recent operations
  install <source> [--enable] [--dev]   .codexmod file, or a folder with --dev
  consent <modId> --approve|--deny [--enable]
  enable|disable|clear-quarantine|reload <modId>
  automatic <modId> <action> on|off     one automatic action's switch (it acts without asking while on)
  policy <modId> <policy> on|off        one of its policies' switch (off: it binds nobody)
  permission <modId> <grant> allow|ask|deny   your decision on one of its optional permissions
  reattach <modId> [--generation <id>]     put preserved data back (newest generation by default)
  configure <modId> --set key=value ...
  update <modId> <source>
  rollback <modId> <version> [--restore-data]
  remove <modId> [--delete-data]

Options: --root <dir> --profile <name> --json --no-wait`;

const need = (positionals, n, usage) => {
  if (positionals.length !== n) throw new UsageError(`usage: codexmods mods ${usage}`);
  return positionals;
};

/** "a.b=3" → sets nested path; the value is JSON when it parses, otherwise the raw string. */
/** `key=value` as a settings patch: the key as given (a v1 nested path is its names joined by "."), the value as JSON or else text. */
export function parseSet(expr) {
  const eq = expr.indexOf('=');
  if (eq < 1) throw new UsageError(`--set expects key=value, got "${expr}"`);
  const raw = expr.slice(eq + 1);
  let value;
  try { value = JSON.parse(raw); } catch { value = raw; }
  return { key: expr.slice(0, eq), value };
}

export function applySet(target, expr) {
  const eq = expr.indexOf('=');
  if (eq < 1) throw new UsageError(`--set expects key=value, got "${expr}"`);
  const path = expr.slice(0, eq).split('.');
  let value;
  const raw = expr.slice(eq + 1);
  try { value = JSON.parse(raw); } catch { value = raw; }
  let cur = target;
  for (const key of path.slice(0, -1)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new UsageError(`--set: refusing key "${key}"`);
    if (cur[key] === null || typeof cur[key] !== 'object' || Array.isArray(cur[key])) cur[key] = {};
    cur = cur[key];
  }
  const last = path.at(-1);
  if (last === '__proto__' || last === 'constructor' || last === 'prototype') throw new UsageError(`--set: refusing key "${last}"`);
  cur[last] = value;
  return target;
}

function printInspect(io, d) {
  out(io, `${d.name} (${d.id}) ${d.version}`);
  out(io, `  status:       ${d.status}${d.quarantine ? ` (${d.quarantine.reason})` : ''}`);
  out(io, `  publisher:    ${d.dev ? 'Development (unsigned)' : d.publisherFingerprint ?? 'unknown'}`);
  out(io, `  compatibility: ${d.compatibility}`);
  out(io, `  data:         ${bytes(d.dataBytes)}`);
  out(io, `  versions:     ${d.versionsInStore.join(', ') || '(none)'}`);
  if (d.snapshots.length) out(io, `  snapshots:    ${d.snapshots.map((s) => `${s.fromVersion} (${ago(s.at)})`).join(', ')}`);
  if (d.publisherChange) out(io, `  PUBLISHER CHANGE: ${d.publisherChange.oldFingerprint} -> ${d.publisherChange.newFingerprint}`);
  if (d.orphanedGenerations?.length) out(io, `  preserved data: ${d.orphanedGenerations.map((g) => `${g.at} (v${g.version})`).join(', ')}`);
  if (d.pendingUpdate) out(io, `  pending update ${d.pendingUpdate.version}: adds ${d.pendingUpdate.addedPermissions.join(', ') || 'no permissions'}`);
  out(io, '  permissions:');
  if (d.permissionText.length === 0) out(io, '    (none)');
  for (const p of d.permissionText) out(io, `    [${p.risk}] ${p.text}`);
  if (d.pendingPermissionText?.length) {
    out(io, '  added by the pending update:');
    for (const p of d.pendingPermissionText) out(io, `    [${p.risk}] ${p.text}`);
  }
  if (d.recentOps.length) { out(io, '  recent operations:'); for (const o of d.recentOps) out(io, `    ${opSummary(o)}`); }
}

export async function run(argv, io) {
  return guarded(io, async () => {
    const { first: sub, rest } = splitFirst(argv);
    if (!sub || sub === 'help') {
      const help = sub === 'help' || rest.includes('--help') || rest.includes('-h');
      out(io, USAGE);
      return help ? EXIT.ok : EXIT.usage;
    }
    const extra = {
      enable: { type: 'boolean' }, dev: { type: 'boolean' }, approve: { type: 'boolean' }, deny: { type: 'boolean' },
      'restore-data': { type: 'boolean' }, 'delete-data': { type: 'boolean' },
      generation: { type: 'string' }, set: { type: 'string', multiple: true },
    };
    const { values, positionals } = parse(rest, extra);
    if (values.help) { out(io, USAGE); return EXIT.ok; }
    const ctx = contextFor(io, values);
    const run = (fn) => withHost(ctx, fn);
    const doMutate = (method, params) => run((c) => mutate(c, io, values, method, params));

    switch (sub) {
      case 'list': {
        need(positionals, 0, 'list');
        return run(async (c) => {
          const { mods } = await c.call('mods.list');
          if (values.json) { printJson(io, { mods }); return EXIT.ok; }
          if (mods.length === 0) { out(io, 'No mods installed.'); return EXIT.ok; }
          out(io, table(mods, [
            { title: 'ID', get: (m) => m.id }, { title: 'NAME', get: (m) => m.name }, { title: 'VERSION', get: (m) => m.version },
            { title: 'STATUS', get: (m) => m.status + (m.pendingUpdate ? ` (update ${m.pendingUpdate.version} awaiting consent)` : '') },
            { title: 'COMPAT', get: (m) => m.compatibility },
            { title: 'PUBLISHER', get: (m) => (m.dev ? 'dev' : m.publisherFingerprint ?? '-') },
          ]));
          return EXIT.ok;
        });
      }
      case 'inspect': {
        const [modId] = need(positionals, 1, 'inspect <modId>');
        return run(async (c) => {
          const d = await c.call('mods.inspect', { modId });
          if (values.json) printJson(io, d); else printInspect(io, d);
          return EXIT.ok;
        });
      }
      case 'install': {
        const [source] = need(positionals, 1, 'install <source> [--enable] [--dev]');
        return doMutate('mods.install', { source: absPath(io, source), ...(values.enable ? { enable: true } : {}), ...(values.dev ? { dev: true } : {}) });
      }
      case 'consent': {
        const [modId] = need(positionals, 1, 'consent <modId> --approve|--deny [--enable]');
        if (values.approve === values.deny) throw new UsageError('consent needs exactly one of --approve or --deny');
        if (values.deny && values.enable) throw new UsageError('--enable only applies with --approve');
        return doMutate('mods.consent', { modId, approve: Boolean(values.approve), ...(values.enable ? { enable: true } : {}) });
      }
      case 'reattach': {
        const [modId] = need(positionals, 1, 'reattach <modId> [--generation <id>]');
        return doMutate('mods.reattach', { modId, ...(values.generation ? { generation: values.generation } : {}) });
      }
      case 'enable': case 'disable': {
        const [modId] = need(positionals, 1, `${sub} <modId>`);
        return doMutate(`mods.${sub}`, { modId });
      }
      case 'reload': {
        const [modId] = need(positionals, 1, 'reload <modId>');
        return doMutate('mods.reload', { modId });
      }
      case 'clear-quarantine': {
        const [modId] = need(positionals, 1, 'clear-quarantine <modId>');
        return doMutate('mods.clearQuarantine', { modId });
      }
      case 'permission': {
        const [modId, grant, decision] = need(positionals, 3, 'permission <modId> <grant> allow|ask|deny');
        if (!['allow', 'ask', 'deny'].includes(decision)) throw new UsageError('permission <modId> <grant> allow|ask|deny');
        return doMutate('mods.setPermission', { modId, grant, decision });
      }
      case 'policy': {
        const [modId, policy, state] = need(positionals, 3, 'policy <modId> <policy> on|off');
        if (state !== 'on' && state !== 'off') throw new UsageError('policy <modId> <policy> on|off');
        return doMutate('mods.setPolicy', { modId, policy, on: state === 'on' });
      }
      case 'automatic': {
        const [modId, action, state] = need(positionals, 3, 'automatic <modId> <action> on|off');
        if (state !== 'on' && state !== 'off') throw new UsageError('automatic <modId> <action> on|off');
        return doMutate('mods.setAutomatic', { modId, action, on: state === 'on' });
      }
      case 'configure': {
        const [modId] = need(positionals, 1, 'configure <modId> --set key=value ...');
        const sets = values.set ?? [];
        if (sets.length === 0) throw new UsageError('configure needs --set');
        // patches of the app scope (one operation: several stay together), never a read-modify-write of a document
        const patches = sets.map((s) => ({ ...parseSet(s), scope: 'app' }));
        return run(async (c) => mutate(c, io, values, 'mods.configure', { modId, patches }));
      }
      case 'update': {
        const [modId, source] = need(positionals, 2, 'update <modId> <source>');
        return doMutate('mods.update', { modId, source: absPath(io, source) });
      }
      case 'rollback': {
        const [modId, toVersion] = need(positionals, 2, 'rollback <modId> <version> [--restore-data]');
        return doMutate('mods.rollback', { modId, toVersion, restoreData: Boolean(values['restore-data']) });
      }
      case 'remove': {
        const [modId] = need(positionals, 1, 'remove <modId> [--delete-data]');
        return doMutate('mods.remove', { modId, deleteData: Boolean(values['delete-data']) });
      }
      default:
        err(io, `codexmods mods: unknown subcommand "${sub}"\n\n${USAGE}`);
        return EXIT.usage;
    }
  });
}
