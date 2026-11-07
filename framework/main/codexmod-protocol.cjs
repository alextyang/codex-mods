'use strict';
// codexmod://<modId>/<rev>/<path> (ARCHITECTURE.md 9.1; contracts/ipc.d.ts HostToMain renderer-modules).
// Read-only, served from the packageDir in the latest renderer-modules map; escape-safe; unknown modId or rev -> 404.
const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8',
};
const SCHEME = 'codexmod';
const APP_ORIGIN = 'app://-';        // the app's page realm: the only origin that imports mod renderer modules

function createCodexmodResolver() {
  /** lowercase modId -> { packageDir, rev } */
  let mods = new Map();
  function setModules(list) {
    mods = new Map();
    for (const m of list) mods.set(String(m.modId).toLowerCase(), { packageDir: m.packageDir, rev: String(m.rev) });
  }
  const miss = (status = 404) => ({ status });

  /** @returns {{status:number, file?:string, mime?:string}} */
  function resolve(urlString, method = 'GET') {
    if (method !== 'GET' && method !== 'HEAD') return miss(405);
    let url;
    try { url = new URL(urlString); } catch { return miss(400); }
    if (url.protocol !== `${SCHEME}:`) return miss(404);
    const mod = mods.get(url.hostname.toLowerCase());
    if (!mod) return miss();
    const raw = url.pathname.split('/').slice(1);                 // [rev, ...path]
    if (raw.length < 2) return miss();
    let segs;
    try { segs = raw.map((s) => decodeURIComponent(s)); } catch { return miss(400); }
    if (segs[0] !== mod.rev) return miss();
    const rel = segs.slice(1);
    for (const s of rel) {
      if (s === '' || s === '.' || s === '..' || s.includes('/') || s.includes('\\') || s.includes('\0')) return miss();
    }
    try {
      const base = fs.realpathSync(mod.packageDir);
      const real = fs.realpathSync(path.join(base, ...rel));
      if (real !== base && !real.startsWith(base + path.sep)) return miss();
      if (!fs.statSync(real).isFile()) return miss();
      return { status: 200, file: real, mime: MIME[path.extname(real).toLowerCase()] || 'application/octet-stream' };
    } catch { return miss(); }
  }

  /** Full response parts for a protocol handler. CORS allows the app's origin (app://-) so its page realm can import the module. */
  async function serve(urlString, method = 'GET') {
    const r = resolve(urlString, method);
    const headers = { 'Access-Control-Allow-Origin': APP_ORIGIN, Vary: 'Origin', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
    if (r.status !== 200) return { status: r.status, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }, body: String(r.status) };
    try {
      const body = method === 'HEAD' ? null : await fs.promises.readFile(r.file);
      return { status: 200, headers: { ...headers, 'Content-Type': r.mime }, body };
    } catch { return { status: 404, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }, body: '404' }; }
  }

  return { setModules, resolve, serve, SCHEME };
}

module.exports = { createCodexmodResolver, SCHEME, APP_ORIGIN };
