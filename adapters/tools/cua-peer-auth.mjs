// Computer Use local-socket peer trust (decision N9, adapter NOTES 20770): the app-tools and in-app-browser pipes authorize their socket peers against OpenAI's own
// signing identity, which a copy re-signed under the user's identity cannot present. The sockets are mode 0600 in the copy's private per-profile run directory, so the
// copy relies on that location-based access control instead.
//
// Edit (mandatory, hash-checked, fail closed; the minified name is captured from the bundle, never assumed):
//  - `cua-disable-cu-peer-auth`  the peer-authorizer factory returns the allow-all authorizer first (`return()=>({authorized:!0});` right after its head); its
//                               stock body stays as dead code. The factory is the one function that logs `browser-use native pipe peer authorization disabled`
//                               and reads the build flavor (`shouldIncludeBrowserUsePeerAuthorization`); it already returns exactly that authorizer off macOS.
//
// This edit was carried in the 20770 pack by hand (commit b40b2f2c) before a deriver existed; `deriveCuaPeerAuthTransform` reproduces it from the bundle.
import vm from 'node:vm';
import { applyOp, findMainBundle } from './transform.mjs';
import { matchClose } from './scan.mjs';

const ID = '[A-Za-z_$][\\w$]*';
export const PEER_AUTH_ID = 'cua-disable-cu-peer-auth';
const LOGGER = 'browser-use-native-pipe-peer-authorizer';
const DISABLED_LOG = 'browser-use native pipe peer authorization disabled';
const FLAVOR = 'shouldIncludeBrowserUsePeerAuthorization(';
const Q = '[`"\']';   // a string literal's quote: 21477 writes template literals, 22943 quoted strings
/** The factory's macOS check in either order and quote (22943 writes `"darwin"!==process.platform`), after an optional declaration. */
const MAC_CHECK = `(?:let ${ID};)?if\\((?:process\\.platform!==${Q}darwin${Q}|${Q}darwin${Q}!==process\\.platform)\\)`;
/** The edit's text: the allow-all authorizer the factory already returns off macOS. */
export const ALLOW_ALL = 'return()=>({authorized:!0});';

/** The peer-authorizer factory in a main bundle: `{ name, head, body }`, or `{ error }`. */
export function locatePeerAuthorizer(text) {
  const logger = [...text.matchAll(new RegExp(`${Q}${LOGGER}${Q}`, 'g'))].length;
  if (logger !== 1) return { error: `\`${LOGGER}\` occurs ${logger} times (expected exactly 1)` };
  const re = new RegExp(`function (${ID})\\(\\)\\{${MAC_CHECK}return\\(\\)=>\\(\\{authorized:!0\\}\\);`, 'g');
  const hits = [...text.matchAll(re)].map((m) => {
    const open = m.index + m[0].indexOf('{');
    const close = matchClose(text, open);
    return { name: m[1], head: `function ${m[1]}(){`, at: m.index, body: close < 0 ? '' : text.slice(open, close + 1) };
  }).filter((h) => h.body.includes(DISABLED_LOG) && h.body.includes(FLAVOR) && h.body.includes('authorized:!1'));
  if (hits.length !== 1) return { error: `${hits.length} functions start with the macOS check and hold the "${DISABLED_LOG}" log and ${FLAVOR}…) (expected exactly 1)` };
  return hits[0];
}

/** @returns {{ drafts: object[], missing: {item: string, mandatory: true, tried: string}[] }} */
export function deriveCuaPeerAuthTransform(source) {
  const miss = (tried) => ({ drafts: [], missing: [{ item: `transform:${PEER_AUTH_ID}`, mandatory: true, tried }] });
  const found = findMainBundle(source, [LOGGER, DISABLED_LOG, FLAVOR]);
  if (found.error) return miss(found.error);
  const { file, text } = found;
  const loc = locatePeerAuthorizer(text);
  if (loc.error) return miss(loc.error);
  if (text.split(loc.head).length - 1 !== 1) return miss(`\`${loc.head}\` occurs ${text.split(loc.head).length - 1} times in ${file} (expected exactly 1)`);
  const draft = { id: PEER_AUTH_ID, seam: 'other', file, op: 'insert-after-once', find: loc.head, text: ALLOW_ALL,
    why: 'N9: the copy relies on the mode-0600 sockets of its private per-profile run directory for the Computer Use app-tools / in-app-browser peer authorization, in place of the stock OpenAI-identity pin a re-signed copy cannot present' };
  // dry run: the edit applies exactly once, the result still compiles, and the factory now answers before anything else
  let patched;
  try { patched = applyOp(text, draft); } catch (e) { return miss(`dry run failed: ${e.message}`); }
  try { new vm.Script(patched, { filename: file }); } catch (e) { return miss(`the patched bundle does not compile: ${String(e.message).split('\n')[0]}`); }
  const lead = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`${lead(loc.head)}${lead(ALLOW_ALL)}${MAC_CHECK}`).test(patched)) return miss('the factory does not start with the allow-all authorizer after the edit');
  return { drafts: [draft], missing: [] };
}
