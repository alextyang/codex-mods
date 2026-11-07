// Electron-main integration contract (framework-main).
// framework/main/index.cjs calls, in this order, synchronously, after starting the Host:
//   require('./views/index.cjs').register(hooks)     // preload registration, renderer ports, pickFile
//   require('./recovery/index.cjs').register(hooks)  // health signal, safe-mode dialog
//   require('./read-state.cjs').register(hooks)      // the app's read state, kept in step with the Host's graph (presentations.md V12)
// Each module exports exactly `register(hooks: MainHooks): void` and must not throw (errors go to hooks.log).
// No module other than electron-adapter.cjs requires 'electron'; everything goes through hooks.electron.
import type { MainToHost, HostToMain } from './ipc.js';
import type { Json } from '../sdk/index.js';

export interface ElectronAdapter {
  app: { on(event: string, fn: (...a: unknown[]) => void): void; getAppPath(): string; quit(): void; relaunch(): void; exit(code?: number): void };
  session: { registerPreloadScript(opts: { type: 'frame'; filePath: string }): void };
  /** MessageChannelMain pair. */
  createChannel(): { port1: unknown; port2: unknown };
  /** Every BrowserWindow, now and future. windowId = webContents.id of its main frame. */
  onWindowCreated(fn: (win: unknown, windowId: number) => void): void;
  /** webContents.postMessage(channel, message, transfer) for the window. */
  postToWindow(windowId: number, channel: string, message: unknown, transfer?: unknown[]): void;
  /** ipcMain.handle on a codexmods:* channel; senders are checked to be app windows created by this app. */
  handle(channel: `codexmods:${string}`, fn: (windowId: number, ...args: unknown[]) => unknown): void;
  /** ipcMain.on with event.returnValue, for ipcRenderer.sendSync (what a page needs before its first render); same sender checks,
   *  an untrusted sender gets null. */
  handleSync?(channel: `codexmods:${string}`, fn: (windowId: number, ...args: unknown[]) => unknown): void;
  showOpenDialog(windowId: number, opts: { filters?: { name: string; extensions: string[] }[]; properties: string[] }): Promise<string[] | null>;
  showMessageBox(opts: { message: string; buttons: string[] }): Promise<number>;
  appUrl(): string; // the app's own renderer URL (e.g. app://-/index.html)
  /** Shows a file or folder in Finder (shell.showItemInFolder); throws for a path that is not absolute. */
  revealPath?(path: string): void;
  /** A question only the user can answer (runtime-core.md R17): the app's native dialog with Don't Allow first (the default and the cancel),
   *  an optional checkbox; `signal` closes it unanswered. */
  askUser?(o: { message: string; detail?: string; checkboxLabel?: string; signal?: AbortSignal }): Promise<{ allowed: boolean; checked: boolean }>;
}
/**
 * The AppHost hold (framework/main/apphost.cjs). The adapter pack's `app-host` seam makes the app's main code call
 * `globalThis.__codexmods.appHost(host, sender, view)` once per window, after it registers the window's AppView (PageHooks.appHost in adapter.d.ts);
 * `start()` installs that hook before the app's main code runs. `host` is the window's AppHost: the services main exports to it, `host.services.<name>`.
 * `view` is the window's AppView: the services the window exports to main over the same port (`view.services.<name>`, Cap'n Web RPC), or
 * null with a pack sealed before the seam passed it.
 * Hosts are kept by sender id, dropped when the sender is destroyed or a reload gives it a new host. Nothing here throws.
 */
export interface AppHostHold {
  /** The live windows' hosts, in the order they were held. */
  windows(): { id: number; host: any; view: any }[];
  first(): { id: number; host: any; view: any } | null;
  /** 'added' (also for a reloaded page's new host, after the 'removed' of the old one) and 'removed'. */
  subscribe(fn: (e: { type: 'added' | 'removed'; id: number; host: any; view: any }) => void): { dispose(): void };
  dispose(): void;
}
export interface MainHooks {
  electron: ElectronAdapter;
  /** The windows' AppHosts (see AppHostHold). */
  appHost: AppHostHold;
  layout: ReturnType<typeof import('./layout.mjs').layout>;
  adapter: import('./adapter.js').AdapterPack;
  frameworkDir: string;                       // <root>/framework/<version>
  safe: boolean;
  sendToHost(msg: MainToHost): void;
  /** Bridge one window channel (a MessagePortMain whose other end went to the renderer) to the Host as {type:'realm'} envelopes.
   *  Implemented by framework-main; closes the bridge when the port or window closes (sends realm-close). */
  bridgeRealm(windowId: number, channel: 'renderer' | 'management', mainPort: unknown): void;
  onHostMessage<T extends HostToMain['type']>(type: T, fn: (msg: Extract<HostToMain, { type: T }>) => void): void;
  /** A feature area's operations (breadth.md D5, D10): the Host's `area-op` for `area` runs `fn(op, args)`; its value is the answer's
   *  `result`, a throw a failure (`refused` when the error has `refused: true`: nothing was tried). One function per area. */
  onAreaOp(area: string, fn: (op: string, args: { [k: string]: Json }) => unknown): void;
  /** Push what an area read from the app to the Host (`area-report`). */
  areaReport(area: string, report: Json): void;
  log: { info(m: string, d?: unknown): void; error(m: string, d?: unknown): void };
}
