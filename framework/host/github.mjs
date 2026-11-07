// A mod from GitHub (docs/design/framework-ui.md F10): the latest release of a repository, and its one signed `.codexmod` asset, downloaded. The signature is the identity and the
// repository is where to look: the package goes through the same checks as a file (its ZIP, its signature, the immutable store, the publisher's key), so this only finds and fetches
// it. A repository with no release, or a release with no such asset, says so. A lookup that fails (no network, the rate limit) says that and never falls through. Every request is
// HTTPS, bounded in size and time, and a redirect is followed only to GitHub's own hosts. Nothing is read from what it fetched before the package checks read it. Node built-ins only.
import { request as httpsRequest } from 'node:https';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CodexModsError } from '../../sdk/errors.mjs';

const API = 'https://api.github.com';
/** The hosts a request may go to, a redirect included. */
export const GITHUB_HOSTS = Object.freeze(['api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'codeload.github.com']);
/** A package is at most this big; a reply of the API at most this. */
export const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

const invalid = (m) => new CodexModsError('Invalid', m);
const unavailable = (m) => new CodexModsError('Unavailable', m);

/** `owner/repository` as given, or from a github.com URL; null when it is neither. */
export function repoOf(text) {
  const t = String(text ?? '').trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const m = /^(?:https:\/\/github\.com\/)?([^/\s]+\/[^/\s]+)$/.exec(t);
  return m && REPO.test(m[1]) && !m[1].split('/')[1].startsWith('.') ? m[1] : null;
}

/** The default transport: one HTTPS GET, its status, headers and body stream. */
function get(url, headers, signal) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: 'GET', headers, signal }, (res) => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res }));
    req.once('error', reject);
    req.end();
  });
}

/**
 * @param {{ transport?: (url: string, headers: object, signal: AbortSignal) => Promise<{ status: number, headers: object, body: AsyncIterable<Buffer> & { destroy?: Function } }>,
 *   timeoutMs?: number, maxBytes?: number, userAgent?: string }} [o]
 */
export function createGitHub(o = {}) {
  const transport = o.transport ?? get;
  const timeoutMs = o.timeoutMs ?? TIMEOUT_MS;
  const maxBytes = o.maxBytes ?? MAX_PACKAGE_BYTES;
  const headers = { 'User-Agent': o.userAgent ?? 'codexmods', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };

  /** A GET that follows redirects to GitHub's hosts only, bounded in time; `sink(body)` reads the final reply. */
  async function fetchTo(url, accept, sink) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    timer.unref?.();
    try {
      let at = url;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const u = new URL(at);
        if (u.protocol !== 'https:' || !GITHUB_HOSTS.includes(u.hostname)) throw invalid(`a download went to ${u.protocol}//${u.hostname}, which is not GitHub's`);
        let res;
        try { res = await transport(u.href, { ...headers, ...(accept ? { Accept: accept } : {}) }, ctl.signal); } catch (e) {
          throw unavailable(ctl.signal.aborted ? `GitHub did not answer within ${Math.round(timeoutMs / 1000)} s` : `Couldn’t reach github.com (${e?.code ?? e?.message ?? e}). Check your connection and try again.`);
        }
        if ([301, 302, 303, 307, 308].includes(res.status)) {
          res.body?.destroy?.();
          const next = res.headers?.location;
          if (typeof next !== 'string' || !next) throw unavailable('GitHub sent a redirect with no place to go');
          at = new URL(next, u).href;
          continue;
        }
        return await sink(res);
      }
      throw unavailable('GitHub sent too many redirects');
    } catch (e) {
      if (ctl.signal.aborted && !(e instanceof CodexModsError)) throw unavailable(`GitHub did not answer within ${Math.round(timeoutMs / 1000)} s`);
      throw e;
    } finally { clearTimeout(timer); }
  }

  /** What a reply that is not a success says. */
  function failure(res, what) {
    res.body?.destroy?.();
    if ((res.status === 403 || res.status === 429) && String(res.headers?.['x-ratelimit-remaining'] ?? '') === '0') {
      const reset = Number(res.headers?.['x-ratelimit-reset']);
      return unavailable(`GitHub’s rate limit for requests without an account is used up${Number.isFinite(reset) ? `; it resets at ${new Date(reset * 1000).toISOString().slice(11, 16)} UTC` : ''}. Try again later.`);
    }
    if (res.status === 404) return invalid(`${what} was not found on GitHub.`);
    return unavailable(`GitHub answered ${res.status} for ${what}`);
  }

  async function json(url, what) {
    return fetchTo(url, null, async (res) => {
      if (res.status !== 200) throw failure(res, what);
      const parts = [];
      let n = 0;
      for await (const chunk of res.body) {
        n += chunk.length;
        if (n > MAX_JSON_BYTES) { res.body.destroy?.(); throw unavailable(`GitHub’s answer for ${what} was too large`); }
        parts.push(chunk);
      }
      try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw unavailable(`GitHub’s answer for ${what} could not be read`); }
    });
  }

  return {
    /**
     * The latest release of `owner/repository` and its one `.codexmod` asset.
     * @returns {Promise<{ repo: string, repoId: number, tag: string, notes: string, asset: { name: string, size: number, url: string } }>}
     */
    async latest(repoText) {
      const repo = repoOf(repoText);
      if (!repo) throw invalid('Enter a GitHub repository as owner/repository.');
      const info = await json(`${API}/repos/${repo}`, repo);
      if (!Number.isSafeInteger(info?.id) || typeof info?.full_name !== 'string') throw unavailable(`GitHub’s answer for ${repo} could not be read`);
      let rel;
      try { rel = await json(`${API}/repos/${info.full_name}/releases/latest`, `a release of ${info.full_name}`); } catch (e) {
        if (e?.code === 'Invalid') throw invalid(`${info.full_name} has no release. A mod is installed from a release with a signed .codexmod package.`);
        throw e;
      }
      const assets = (Array.isArray(rel?.assets) ? rel.assets : []).filter((a) => typeof a?.name === 'string' && a.name.endsWith('.codexmod') && typeof a.browser_download_url === 'string');
      if (!assets.length) throw invalid(`The latest release of ${info.full_name} (${String(rel?.tag_name ?? '')}) has no .codexmod package.`);
      if (assets.length > 1) throw invalid(`The latest release of ${info.full_name} has ${assets.length} .codexmod packages; it should have one.`);
      const a = assets[0];
      if (Number(a.size) > maxBytes) throw invalid(`${a.name} is larger than ${Math.round(maxBytes / 1024 / 1024)} MiB`);
      return { repo: info.full_name, repoId: info.id, tag: String(rel.tag_name ?? ''), notes: typeof rel.body === 'string' ? rel.body.slice(0, 4000) : '', asset: { name: a.name, size: Number(a.size) || 0, url: a.browser_download_url } };
    },

    /** Download an asset to `dest`, bounded; answers its sha256. A partial file is removed. */
    async download(url, dest) {
      await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
      try {
        return await fetchTo(url, 'application/octet-stream', async (res) => {
          if (res.status !== 200) throw failure(res, 'the package');
          const declared = Number(res.headers?.['content-length']);
          if (Number.isFinite(declared) && declared > maxBytes) { res.body.destroy?.(); throw invalid(`the package is larger than ${Math.round(maxBytes / 1024 / 1024)} MiB`); }
          const hash = createHash('sha256');
          const out = createWriteStream(dest, { mode: 0o600 });
          let n = 0;
          try {
            for await (const chunk of res.body) {
              n += chunk.length;
              if (n > maxBytes) { res.body.destroy?.(); throw invalid(`the package is larger than ${Math.round(maxBytes / 1024 / 1024)} MiB`); }
              hash.update(chunk);
              if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
            }
          } finally { await new Promise((r) => out.end(r)); }
          return { digest: `sha256:${hash.digest('hex')}`, bytes: n };
        });
      } catch (e) { await rm(dest, { force: true }); throw e; }
    },
  };
}
