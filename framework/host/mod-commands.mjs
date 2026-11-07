// The mods' commands as graph Commands (docs/graph/02 Command; mod-surfaces.md P5, E8.11): each `ui.commands.add` (a Palette rule carrying a
// `command`) is a Command of the provider `codexmods.commands`, named `<mod>/<id>`, titled as the mod titles it, its category the mod's name.
// `Command.run` runs it as the palette's row does: a host-realm command's callback here; a renderer-realm one in the window in front (the
// page runs its own function, that window's registration of it). It says `ran`, and is done, only when it ran: one that did not run (gone,
// off after a failure, registered again) is refused, one that threw failed, and one whose page went before answering is not known (failed;
// review 4, round 2). The Commands follow the rules: one comes and goes with its rule.
// Node built-ins only.

export const PROVIDER = 'codexmods.commands';
const isCommand = (r) => r && r.kind === 'add' && r.presentation === 'Palette' && r.slot === 'resultSources' && r.data && typeof r.data.command === 'object' && r.data.command !== null;
const refOf = (key) => Object.freeze({ type: 'Command', provider: PROVIDER, id: key });

/**
 * @param {{ graph: object, rules: { snapshot(): object[], subscribe(fn: (d: object) => void): { dispose(): void },
 *     run(key: string, reg: string, path: string, env: object): Promise<{ ran: boolean, why?: string }> },
 *   windows?: () => ({ frontWindow?(): Promise<number | null>, runRule?(windowId: number, msg: object): Promise<object> } | null), nameOf?: (modId: string) => string,
 *   log?: { warn(m: string, d?: object): void } }} o
 */
export function createModCommands(o) {
  const log = o.log ?? { warn() {} };
  const nameOf = (id) => { try { return o.nameOf?.(id) ?? id; } catch { return id; } };
  const current = new Map();   // key -> rule
  let disposed = false;
  const env = (ref, windowId) => Object.freeze({ subject: ref, _presentation: null, window: Number.isSafeInteger(windowId) ? { type: 'Window', provider: 'codexmods.windows', id: String(windowId) } : null,
    thread: null, draft: null, via: 'graph' });
  const handle = o.graph.registerProvider('framework', PROVIDER, {
    types: {
      Command: {
        operations: {
          run: {
            effect: 'external',
            handler: async ({ ref }) => {
              const r = current.get(ref.id);
              if (!r) return { status: 'refused', reason: 'unavailable', message: 'the command is gone' };
              if (r.realm === 'host') {
                let out;
                try { out = await o.rules.run(ref.id, r.reg, 'command.run', env(ref, null)); }
                catch (e) { return { status: 'failed', error: { message: String(e?.message ?? e).slice(0, 300) } }; }
                if (!out?.ran) return { status: 'refused', reason: 'unavailable', message: out?.why === 'failed' ? 'the command failed before and is off until its mod registers it again' : 'the command is gone' };
              } else {
                const w = o.windows?.() ?? null;
                const windowId = w?.frontWindow ? await w.frontWindow() : null;
                const reg = Number.isSafeInteger(windowId) ? r.regs?.[String(windowId)] : undefined;
                if (typeof reg !== 'string' || typeof w.runRule !== 'function') return { status: 'refused', reason: 'unavailable', message: 'the window in front does not run this command' };
                const out = await w.runRule(windowId, { key: ref.id, reg, path: 'command.run', env: env(ref, windowId) });
                if (out?.status !== 'done') return out ?? { status: 'failed', error: { message: 'the window gave no answer' } };
              }
              try { handle.emit(ref, 'ran', null); } catch { /* gone meanwhile */ }
              return null;
            },
          },
        },
      },
    },
  });
  function put(r) {
    const key = `${r.mod}/${r.id}`;
    const c = r.data.command;
    current.set(key, r);
    try {
      handle.put(refOf(key), { state: { title: typeof c.title === 'string' ? c.title : r.id, category: nameOf(r.mod), enabled: true }, links: { shortcut: null } });
    } catch (e) { log.warn('a mod\'s command could not be put', { command: key, message: String(e?.message ?? e) }); }
  }
  function remove(key) {
    if (!current.delete(key)) return;
    try { handle.remove(refOf(key)); } catch { /* gone */ }
  }
  for (const r of o.rules.snapshot()) if (isCommand(r)) put(r);
  const sub = o.rules.subscribe((d) => {
    if (disposed || !d) return;
    if (d.t === 'remove') { remove(d.key); return; }
    if (d.t === 'put' && d.rule) { if (isCommand(d.rule)) put(d.rule); else remove(`${d.rule.mod}/${d.rule.id}`); }
  });
  return {
    dispose() { disposed = true; sub.dispose(); for (const key of [...current.keys()]) remove(key); handle.dispose?.(); },
  };
}
