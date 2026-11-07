// Builds each mod's `ui` namespace (sdk Ui). Everything a mod obtains through it is tracked, so unloading the mod (module
// removed, disabled, quarantined, window closing) removes its rules and subscriptions in one dispose().
import { CodexModsError } from '../../sdk/errors.mjs';
import { createRuleApi } from '../shared/ui-rules-client.mjs';
import { createSettingRow } from './present/setting-row.mjs';

/**
 * @param {{ getReact: () => any, components: Record<string, any>, theme: ReturnType<import('./theme.mjs').createTheme>, ruleHandles?: object | null, onRuleRefused?: Function,
 *           panels?: object, filters?: object, settingsPages?: object, kit?: object }} deps  `kit`: the framework's own (the SettingRow draws with it)
 */
export function createUiFactory({ getReact, components, theme, ruleHandles = null, onRuleRefused = () => {}, panels = null, filters = null, settingsPages = null, kit = null }) {
  return {
    /**
     * @param {string} modId
     * @param {{ register(desc: object): Promise<unknown>, dispose(id: string): Promise<unknown> } | undefined} [rulesChannel]  the Host's
     *   presentation rules for this mod (docs/design/systems.md S5): without one the rule methods refuse
     * @param {() => object | undefined} [graph]  the mod's ctx.graph, for `_read` and `_act` on presentations (S10)
     * @returns {{ ui: import('../../sdk/index.js').Ui, dispose(): void }}
     */
    forMod(modId, rulesChannel, graph) {
      const tracked = new Set();
      let disposed = false;
      const gone = () => { if (disposed) throw new CodexModsError('Disposed', `the ui of ${modId} has been disposed`); };
      const track = (d) => {
        const wrapped = { dispose: () => { tracked.delete(wrapped); return d.dispose(); } };
        tracked.add(wrapped);
        return wrapped;
      };
      // The rules (E2): their functions and components stay in this window's handle store; the Host keeps the rule and tells every window.
      const rules = rulesChannel && ruleHandles
        ? createRuleApi({ modId, realm: 'renderer', channel: rulesChannel, local: ruleHandles, graph, onRefused: (id, e) => onRuleRefused(modId, id, e),
          panels: panels ? { open: (id, opts) => panels.open(modId, id, opts), close: (id, opts) => panels.close(modId, id, opts) } : undefined,
          filters: filters ? { set: (id, on) => filters.set(modId, id, on) } : undefined,
          settings: settingsPages ? { open: (page) => settingsPages.open(modId, page) } : undefined,
          mainPages: settingsPages ? { open: (id) => settingsPages.openPage(modId, id) } : undefined })
        : null;
      const noRules = () => { throw new CodexModsError('Unavailable', 'presentation rules are not available in this window'); };
      // Every function and namespace of the shared rule API, the same in both realms (a member added there is here too); without a
      // channel the same shape, each call refusing.
      const forward = (fn) => (...args) => { gone(); return rules ? fn(...args) : noRules(); };
      const shape = rules?.api ?? createRuleApi({ modId, realm: 'renderer', channel: {} }).api;
      const forwarded = Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, typeof v === 'function' ? forward(v)
        : Object.freeze(Object.fromEntries(Object.entries(v).filter(([, f]) => typeof f === 'function').map(([n, f]) => [n, forward(f)])))]));
      // the app's own chat in a place of this mod's (layouts.md D8): `ui.host` declares a region of a presentation; `ui.host.thread` draws one of the app's chats, a pane
      const hostedHost = Object.assign((...args) => forwarded.host(...args), { thread: (ref, opts) => (settingsPages?.hostThread ? settingsPages.hostThread(ref, opts) : null), tab: (kind, ref) => (settingsPages?.hostTab ? settingsPages.hostTab(kind, ref) : null), supported: () => settingsPages?.hostSupported?.() ?? { thread: false, transcript: false, tabs: [] } });
      // the app's components and the kit, with this mod's SettingRow (G3.6: it reads and sets as this mod)
      const own = Object.defineProperties({}, Object.getOwnPropertyDescriptors(components));
      Object.defineProperty(own, 'SettingRow', { enumerable: true, value: createSettingRow({ R: getReact, kit: kit ?? components, exports: () => components, modId, graph: () => graph?.() }) });
      const ui = {
        ...forwarded,
        host: hostedHost,
        get react() { return getReact(); },
        components: Object.freeze(own),
        theme: {
          tokens: () => theme.tokens(),
          onChange: (fn) => track(theme.onChange(fn)),
          get appearance() { return theme.appearance; },
        },
      };
      return {
        ui,
        dispose() {
          if (disposed) return;
          disposed = true;
          try { rules?.disposeAll(); } catch { /* best effort */ }
          for (const d of [...tracked]) { try { d.dispose(); } catch { /* best effort */ } }
          tracked.clear();
        },
      };
    },
  };
}
