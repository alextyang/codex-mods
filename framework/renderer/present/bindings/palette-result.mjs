// PaletteResult (docs/graph/03): one result of the command palette. On 21477 a command's result is the component whose props carry the
// command's descriptor (`command`, with its id) and how to run it; it names the app's Command. It passes through. Choosing it (E7.1) runs
// its Command (the windows provider's route), then closes the palette as the app's own choice does (`close()`). A command a mod hides
// (`ui.hide('Command', ...)`, palette-hides.mjs) is not drawn. NO NODE API.
import { defineBinding } from '../runtime.mjs';
import { paletteHides, commandHiddenBy, tallyCommand, termsOf, chatHides } from './palette-hides.mjs';
import { hiddenBy, openChats } from './sidebar-hides.mjs';

export const paletteCommand = defineBinding({
  id: 'palette.command', presentation: 'PaletteResult',
  place: { in: 'Palette', on: { type: 'App', provider: 'codex', id: 'codex' }, slot: 'results' },   // in the open palette (E7.3)
  presents: ['Command'],
  subject(props) {
    const id = props.command?.id;
    return typeof id === 'string' && id ? { type: 'Command', provider: 'codex', id } : null;
  },
  render(Original, props, factory, ctx, scope, near, rec) {
    const id = props.command?.id;
    if (typeof id !== 'string' || !id) return undefined;
    const row = rec?.n ?? id;   // this row (one command may be drawn by two)
    const hides = paletteHides(ctx);
    if (!hides.length) { tallyCommand(ctx, row, id, null); return undefined; }
    // its Command as the graph holds it, else as the row gives it
    const ref = { type: 'Command', provider: 'codex', id };
    const held = ctx.subject(ref);
    const title = typeof props.command.title === 'string' ? props.command.title : id;
    const inst = held && !held.gone ? held : { ref, state: { title } };
    const by = commandHiddenBy(ctx, hides, inst);
    tallyCommand(ctx, row, id, by, termsOf(props));
    return by ? null : undefined;
  },
  operations: {
    close(props) {
      if (typeof props.close !== 'function') return { unavailable: 'the palette cannot be closed from here' };
      props.close();
      return true;
    },
  },
});

// A chat's row in the command palette (its pinned and recent chats, a search's chats; 21477: exactly twelve props, `result` the chat as
// the palette lists it, `title` what it shows): of a chat of this Mac (`hostId` local), the title its summary gives (public-hooks.md §3.13), its icon before it as the app draws
// a chat's emoji, as its sidebar row reads. The palette still finds it by its own title.
//   A chat the mods hide from the sidebar (`ui.hide('Thread')`, never the one shown nor one busy) is not drawn either, counted in the
// palette's own "Hidden" section with its Show (palette-hides.mjs, H7t).
export const paletteChat = defineBinding({
  id: 'palette.chat', presents: ['Thread'],
  render(Original, props, factory, ctx, scope, near, rec) {
    const r = props.result;
    // a chat of this Mac (another host's of the same id is not the one the graph has)
    if (!r || typeof r !== 'object' || r.kind !== 'local' || r.hostId !== 'local' || typeof r.threadId !== 'string') return undefined;
    const row = rec?.n ?? r.threadId;
    const hides = chatHides(ctx);
    if (hides.length) {
      const ref = ctx.thread(r.threadId);
      const inst = ref ? ctx.subject(ref) : null;
      const by = inst && !inst.gone ? hiddenBy(ctx, hides, inst, openChats(ctx)) : null;
      // its terms: its title, and the search that found it (a match in its messages or branch: the notice is offered for it too)
      const terms = [typeof props.title === 'string' && props.title ? props.title : r.threadId, ...(typeof props.trimmedSearch === 'string' && props.trimmedSearch ? [props.trimmedSearch] : [])];
      tallyCommand(ctx, row, `chat:${r.threadId}`, by, terms);
      if (by) return null;
    } else tallyCommand(ctx, row, `chat:${r.threadId}`, null);
    if (typeof ctx.threadSummary !== 'function') return undefined;
    const s = ctx.threadSummary(r.threadId);
    if (!s || (!s.title && !s.icon)) return undefined;
    const base = s.title ?? props.title;
    return factory(Original, { ...props, title: s.icon && typeof base === 'string' ? `${s.icon} ${base}` : base });
  },
});
