// The Dock (the setup app's last step, and the first of its uninstall): for everyday use the copy takes ChatGPT's place in the Dock; to try
// it, it goes beside ChatGPT. What was there is recorded, so uninstalling puts it back exactly: ChatGPT's own tile where the copy's was, or
// the copy's tile gone. The edits are to `com.apple.dock`'s persistent-apps as `defaults export` gives it; the Dock restarts to read them.
// Only tiles whose file is the copy's or ChatGPT's are ever touched. Node built-ins only.
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomInt } from 'node:crypto';
import { parsePlist, writePlist, get, set, remove, clone } from './plist.mjs';

/** A tile's file path (no trailing slash), or null. */
export function tilePath(tile) {
  const url = get(get(get(tile, 'tile-data'), 'file-data'), '_CFURLString');
  if (url?.t !== 'string') return null;
  try {
    const p = url.v.startsWith('file://') ? fileURLToPath(url.v) : url.v;
    return p.replace(/\/+$/, '') || null;
  } catch { return null; }
}

const appsOf = (dock) => {
  const apps = get(dock, 'persistent-apps');
  if (apps?.t !== 'array') throw new Error('the Dock has no app list');
  return apps;
};
/** Where `path`'s tile is in the Dock's apps, or -1. */
export const indexOf = (dock, path) => appsOf(dock).v.findIndex((t) => tilePath(t) === path.replace(/\/+$/, ''));

/** A tile for the copy, made from ChatGPT's (or any app's) tile: its file, name and bundle id; no bookmark, so the Dock goes by the path. */
export function tileFor(template, { path, label, bundleId }) {
  const tile = clone(template);
  set(tile, 'GUID', { t: 'integer', v: String(randomInt(1, 2 ** 31 - 1)) });
  const data = get(tile, 'tile-data');
  remove(data, 'book');
  for (const k of ['file-mod-date', 'parent-mod-date', 'dock-extra', 'is-beta']) remove(data, k);
  set(data, 'file-label', { t: 'string', v: label });
  if (bundleId) set(data, 'bundle-identifier', { t: 'string', v: bundleId });
  else remove(data, 'bundle-identifier');
  const file = get(data, 'file-data');
  set(file, '_CFURLString', { t: 'string', v: `${pathToFileURL(path.replace(/\/+$/, '')).href}/` });
  set(file, '_CFURLStringType', { t: 'integer', v: '15' });
  return tile;
}

/** A plain app tile, for a Dock with none to model the copy's on. */
const BLANK = Object.freeze({ t: 'dict', v: [['tile-data', { t: 'dict', v: [['file-data', { t: 'dict', v: [['_CFURLString', { t: 'string', v: '' }], ['_CFURLStringType', { t: 'integer', v: '15' }]] }], ['file-label', { t: 'string', v: '' }]] }], ['tile-type', { t: 'string', v: 'file-tile' }]] });

/**
 * The copy put in the Dock. `replace`: in ChatGPT's place (everyday use); otherwise just after it, or at the end when ChatGPT has no tile.
 * A copy already there is left as it is. Answers the Dock as changed and what to put back on uninstall: `{ original }` (ChatGPT's tile,
 * when it was replaced) or `{}` (the copy's tile is only to be taken away); null when nothing changed.
 */
export function placeCopy(dock, { copy, chatgpt, label, bundleId, replace }) {
  const next = clone(dock);
  const apps = appsOf(next);
  if (indexOf(next, copy) >= 0) return null;
  const at = indexOf(next, chatgpt);
  const template = at >= 0 ? apps.v[at] : apps.v.find((t) => get(get(t, 'tile-data'), 'file-data')) ?? BLANK;
  const tile = tileFor(template, { path: copy, label, bundleId });
  if (replace && at >= 0) {
    const original = apps.v[at];
    apps.v[at] = tile;
    return { dock: next, record: { original } };
  }
  apps.v.splice(at >= 0 ? at + 1 : apps.v.length, 0, tile);
  return { dock: next, record: {} };
}

/** What `placeCopy` did, undone: ChatGPT's tile back where the copy's is (unless it is in the Dock again by now), or the copy's tile gone. Null when the copy has no tile. */
export function removeCopy(dock, { copy, chatgpt, record }) {
  const next = clone(dock);
  const apps = appsOf(next);
  const at = indexOf(next, copy);
  if (at < 0) return null;
  if (record?.original && indexOf(next, chatgpt) < 0) apps.v[at] = record.original;
  else apps.v.splice(at, 1);
  return next;
}

const run = (cmd, args, input) => new Promise((res, rej) => {
  const p = execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, timeout: 30000 }, (e, out, err) => (e ? rej(new Error(`${cmd} ${args[0]}: ${String(err || e.message).trim()}`)) : res(out)));
  if (input !== undefined) p.stdin.end(input);
});

/** The Dock's preferences, as macOS reads them now. */
export async function readDock() { return parsePlist(await run('/usr/bin/defaults', ['export', 'com.apple.dock', '-'])); }

/** The Dock's preferences written and the Dock restarted (by its process id, this user's own) to read them. */
export async function writeDock(dock) {
  await run('/usr/bin/defaults', ['import', 'com.apple.dock', '-'], writePlist(dock));
  const uid = String(process.getuid());
  const list = await run('/bin/ps', ['-x', '-U', uid, '-o', 'pid=,comm=']);
  for (const line of list.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && m[2] === '/System/Library/CoreServices/Dock.app/Contents/MacOS/Dock') { try { process.kill(Number(m[1]), 'SIGTERM'); } catch { /* it restarted meanwhile */ } }
  }
}
