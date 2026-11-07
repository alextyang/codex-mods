// The app's commands and their key bindings (breadth step D6). The static catalog comes from main; the app's keymap service owns every
// read and lasting change. Polling observes user changes, and a mod's lasting change asks first (R17).
import { refs } from '../map.mjs';

export const realizes = {
  types: ['Command', 'Shortcut'],
  operations: { Command: ['run'], Shortcut: ['rebind', 'reset'] },
  supports: { Command: ['appliesTo'] },
  events: { Command: ['ran'], Shortcut: ['changed'] },
  links: { Command: ['shortcut'], Shortcut: ['command'] },
};

const APPLIES_TO = new Set(['archiveThread', 'copyDeeplink', 'copyConversationMarkdown', 'copyWorkingDirectory', 'markThreadUnread', 'openThreadInNewWindow', 'openSideChat', 'toggleThreadPin', 'renameThread']);

/** A readable fallback when the app's command descriptor has no menu title. */
export function titleOf(id) {
  const words = id.slice(id.lastIndexOf('.') + 1).replace(/([A-Z])/g, ' $1').replace(/(\d+)/g, ' $1 ').trim().replace(/\s+/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function commandData(entry) {
  return {
    ref: refs.command(entry.id),
    state: {
      title: entry.title ?? titleOf(entry.id), category: entry.group ?? 'other',
      // Whether the desktop app can run it at all. Whether a mounted component handles it right now belongs to the page (step E).
      enabled: entry.kind !== 'vscode-only',
      ...(APPLIES_TO.has(entry.id) ? { appliesTo: 'Thread' } : {}),
    },
    links: {},
  };
}

export function shortcutsData(entry, keymap) {
  const overrides = (keymap.bindings ?? []).filter((binding) => binding.command === entry.id);
  const custom = overrides.length > 0;
  const keys = custom ? overrides.filter((binding) => binding.key !== null).map((binding) => binding.key) : entry.defaults;
  return keys.map((keys, i) => ({ ref: refs.shortcut(entry.id, i), state: { keys, custom }, links: { command: refs.command(entry.id) } }));
}

export function types(feed) {
  return {
    Command: { operations: { run: { effect: 'external', handler: ({ ref }) => feed().run(ref) } } },
    Shortcut: { operations: {
      rebind: { effect: 'external', approval: ({ ref, args }) => feed().prompt('rebind', ref, args[0]), handler: ({ ref, args }) => feed().rebind(ref, args[0]) },
      reset: { effect: 'external', approval: ({ ref }) => feed().prompt('reset', ref), handler: ({ ref }) => feed().reset(ref) },
    } },
  };
}

export function createFeed(ctx) {
  const now = ctx.now ?? Date.now;
  const refused = (reason, message) => ({ status: 'refused', reason, message });
  let catalog = null, commands = new Map(), shortcuts = new Map();
  let reading = null, again = false, timer = null, disposed = false, heard = false, finishedAt = -Infinity;

  function apply(keymap) {
    if (disposed) return;
    const nextCommands = new Map(), nextShortcuts = new Map();
    for (const entry of catalog.values()) {
      const data = commandData(entry), bindings = shortcutsData(entry, keymap);
      nextCommands.set(entry.id, data);
      for (const binding of bindings) nextShortcuts.set(binding.ref.id, binding);
      ctx.safe('command', () => ctx.handle.put(data.ref, { state: data.state, links: data.links }));
      data.links.shortcut = bindings[0]?.ref ?? null;
    }
    for (const data of nextShortcuts.values()) ctx.safe('shortcut', () => ctx.handle.put(data.ref, { state: data.state, links: data.links }));
    for (const data of nextCommands.values()) ctx.safe('command shortcut', () => ctx.handle.update(data.ref, { links: data.links }));
    for (const [id, data] of shortcuts) if (!nextShortcuts.has(id)) ctx.safe('shortcut removal', () => ctx.handle.remove(data.ref));
    for (const [id, data] of commands) if (!nextCommands.has(id)) ctx.safe('command removal', () => ctx.handle.remove(data.ref));
    for (const [id, data] of nextShortcuts) {
      const before = shortcuts.get(id);
      if (heard && (!before || before.state.keys !== data.state.keys || before.state.custom !== data.state.custom)) ctx.emitEvent(data.ref, 'changed');
    }
    commands = nextCommands; shortcuts = nextShortcuts; heard = true;
  }

  /** Overlapping reads share the running promise and queue just one further read. A failed read keeps every resident instance. */
  function read() {
    if (disposed) return Promise.resolve();
    if (reading) { again = true; return reading; }
    reading = (async () => {
      do {
        again = false;
        try {
          if (!catalog) {
            const r = await ctx.mainOp('catalog', {});
            if (!r.ok) throw new Error(r.error);
            if (disposed) return;
            catalog = new Map(r.result.commands.map((entry) => [entry.id, entry]));
          }
          const r = await ctx.mainOp('keymap', {});
          if (!r.ok) throw new Error(r.error);
          apply(r.result);
        } catch (e) { ctx.log.warn('commands: the commands could not be read', { message: String(e?.message ?? e) }); }
        finally { finishedAt = now(); }
      } while (again && !disposed);
    })().finally(() => { reading = null; });
    return reading;
  }

  async function appOp(op, args) {
    const r = await ctx.mainOp(op, args);
    if (!r.ok) {
      if (r.refused) return refused('unavailable', r.error);
      throw new Error(r.error);
    }
    return r.result;
  }

  function rebindRefusal(ref, keys) {
    if (typeof keys !== 'string' || !keys) return refused('invalid', 'non-empty shortcut keys are needed');
    const binding = shortcuts.get(ref.id);
    if (!binding) return refused('unavailable', 'this shortcut is not known');
    if (catalog.get(binding.links.command.id).configurable === false) return refused('unsupported', 'the app does not let you change this shortcut');
    return null;
  }

  return {
    read,
    start() {
      if (!disposed && !timer) { timer = setInterval(() => { read(); }, 60_000); timer.unref?.(); }
      return read();
    },
    serverUp: () => read(),
    observe(ref, _concept) {
      if (ref.type !== 'Command' && ref.type !== 'Shortcut') return undefined;
      return reading ?? (now() - finishedAt > 30_000 ? read() : Promise.resolve());
    },
    prompt(op, ref, keys) {
      const binding = shortcuts.get(ref.id);
      if (!binding || disposed) return null;
      const commandId = binding.links.command.id;
      if (commandId.length > 200) return null;
      if (op === 'rebind' && (rebindRefusal(ref, keys) || keys === binding.state.keys || keys.length > 200)) return null;
      if (op === 'reset' && !binding.state.custom) return null;
      const title = commands.get(commandId).state.title;
      return {
        action: op === 'rebind' ? `change the shortcut of “${title}” to ${keys}` : `reset the shortcuts of “${title}”`,
        detail: 'Codex keeps your shortcuts in keybindings.json in its home: every window and the menu use them.',
      };
    },
    async run(ref) {
      const entry = catalog?.get(ref.id);
      if (!entry) return refused('unavailable', 'this command is not known');
      const r = await appOp('run', { commandId: entry.id, kind: entry.kind });
      if (r?.status === 'refused') return r;
      ctx.emitEvent(ref, 'ran');
      return null;
    },
    async rebind(ref, keys) {
      const no = rebindRefusal(ref, keys);
      if (no) return no;
      const binding = shortcuts.get(ref.id);
      if (binding.state.keys === keys) return null;
      const r = await appOp('rebind', { commandId: binding.links.command.id, previous: binding.state.keys, keys });
      if (r?.status === 'refused') return r;
      apply(r); finishedAt = now();
      return null;
    },
    async reset(ref) {
      const binding = shortcuts.get(ref.id);
      if (!binding) return refused('unavailable', 'this shortcut is not known');
      if (!binding.state.custom) return null;
      const r = await appOp('reset', { commandId: binding.links.command.id });
      if (r?.status === 'refused') return r;
      apply(r); finishedAt = now();
      return null;
    },
    dispose() { disposed = true; clearInterval(timer); },
  };
}
