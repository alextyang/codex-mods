// Build-tagged captures of the real app-server and their sanitization rules (pulled from the frozen SDK 2 branch by release-2.md §4; used by the
// protocol source tests, integration.md §12). A capture is what a QA copy's backend answered and sent, as one ordered SCRIPT per
// app session; the strict fake app-server (fake-app-server.mjs) replays it exactly, in order, and refuses anything off-script.
//
// The format (`codexmods.capture/1`; docs/DEVELOPMENT.md "Captures and expected traces"):
//   {
//     "format": "codexmods.capture/1",
//     "build": "26.1013.40934-20770",          the app build it was recorded on: contracts/upstream/<build> must exist, and every method is checked against
//                                              that build's protocol schemas (ClientRequest, ClientNotification, ServerNotification, ServerRequest),
//                                              experimental methods included when the build has schema-experimental/
//     "recorded": "2026-10-15",                 the day (a date, never a time of day)
//     "source": "docs/design/realization/proofs/…",   the QA record it came from
//     "doc": "what was done in the app while recording, and what the capture leaves out",
//     "sanitized": ["S1", "S2", "S3", "S4"],    the rules applied (below); `sanitizationIssues` re-checks them
//     "sessions": { "<label>": [ step, ... ] } one script per app session (backend process), by the fake's --name (`primary`, `primary.1`, ...); a
//                                              capture with one session may name it "*" (any name)
//   }
// A step, in order:
//   { "client": "<method>", "params"?: {...}, "result": {...} }      the client's next request (its params must CONTAIN `params`, deep); the fake answers
//   { "client": "<method>", "params"?: {...}, "error": {code, message} }   ... with that error, as captured
//   { "clientNotification": "<method>", "params"?: {...} }           the client's next notification (`initialized`)
//   { "notify": "<method>", "params": {...} }                        the fake sends this notification, as soon as the step before it is done
//   { "serverRequest": "<method>", "params": {...}, "answer"?: {...} }   the fake sends this request; the client's answer must CONTAIN `answer`
// Any step may carry "synthetic": "<why>" when it was not recorded byte for byte but reconstructed (from a QA record, or a reply the recorder did not
// keep); such a step is never evidence of the real backend's shape on its own. Request ids are never captured: the fake answers with the client's id.
//
// Sanitization (every capture, checked by `sanitizationIssues`, so a capture that breaks a rule does not load):
//   S1 no secrets: no value under a key named like a credential (…token, …secret, password, authorization, cookie, apiKey), and no token-shaped
//      string (a JWT, `sk-…`, `Bearer …`, GitHub or Slack tokens, AWS key ids);
//   S2 no account data: no e-mail address, and no value under an account key (email, accountId, userId, orgId, planType);
//   S3 no owner-identifying paths: no `/Users/<name>` or `/home/<name>` other than `/Users/user`, no `/Volumes/<name>` other than `/Volumes/volume`,
//      no `C:\Users\…`, no `~/…`;
//   S4 synthetic ids: every UUID is a synthetic one, `xxxxxxxx-0000-7000-8000-00000000nnnn` (thread and turn ids renumbered in order of first
//      appearance, so their order and grouping survive).
// Node built-ins only (it is test tooling, but the fake app-server loads it).
import { readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CAPTURE_FORMAT = 'codexmods.capture/1';
export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const UPSTREAM = join(REPO, 'contracts', 'upstream');
const STEP_KINDS = ['client', 'clientNotification', 'notify', 'serverRequest'];
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The methods of one build's protocol: { clientRequest, clientNotification, serverNotification, serverRequest, experimental }. Each list is the
 * union of contracts/upstream/<build>/schema and, when the build has it, schema-experimental (the same generator with `--experimental`);
 * `experimental` holds the methods that only the experimental schema has.
 */
export function protocolMethods(build) {
  const dir = join(UPSTREAM, build, 'schema');
  if (!existsSync(dir)) throw new Error(`no protocol schemas for build ${build} (contracts/upstream/${build})`);
  const exp = join(UPSTREAM, build, 'schema-experimental');
  const methodsIn = (d, name) => {
    const file = join(d, `${name}.json`);
    if (!existsSync(file)) return new Set();
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return new Set((j.oneOf ?? j.anyOf ?? []).map((b) => b?.properties?.method?.enum?.[0] ?? b?.properties?.method?.const).filter((m) => typeof m === 'string'));
  };
  const experimental = new Set();
  const methodsOf = (name) => {
    const stable = methodsIn(dir, name);
    const all = new Set(stable);
    if (existsSync(exp)) for (const m of methodsIn(exp, name)) if (!stable.has(m)) { all.add(m); experimental.add(m); }
    return all;
  };
  return { clientRequest: methodsOf('ClientRequest'), clientNotification: methodsOf('ClientNotification'), serverNotification: methodsOf('ServerNotification'), serverRequest: methodsOf('ServerRequest'), experimental };
}

/** Every build whose protocol schemas the repository holds (contracts/upstream/<build>/schema), oldest first. */
export function upstreamBuilds() {
  const builds = readdirSync(UPSTREAM).filter((d) => existsSync(join(UPSTREAM, d, 'schema')));
  const key = (b) => b.split(/[.-]/).map(Number);
  builds.sort((a, b) => { const x = key(a), y = key(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0); return 0; });
  return builds;
}

/** The newest build whose protocol schemas the repository holds (the fake's default). */
export function newestBuild() {
  return upstreamBuilds().at(-1);
}

/**
 * `since` and every newer build with schemas, oldest first: the builds that shape checks run against (the fake app-server's modelled payloads,
 * captured payloads, the app operations the bridge rewrites). A new build joins the list when its schemas are added, so a field it requires that the
 * fake does not send fails the check until it is looked at.
 */
export function buildsSince(since) {
  const all = upstreamBuilds();
  const at = all.indexOf(since);
  if (at < 0) throw new Error(`no protocol schemas for build ${since} (contracts/upstream/${since})`);
  return all.slice(at);
}

// ------------------------------------------------------------------------------------------------ sanitization
const CREDENTIAL_KEY = /(token|secret|password|passwd|authorization|cookie|apikey|api_key|privatekey|private_key)$/i;
const ACCOUNT_KEY = /^(email|e_mail|accountid|account_id|userid|user_id|orgid|org_id|organizationid|organization_id|plantype|plan_type)$/i;
const TOKEN_SHAPES = [
  ['a JWT', /\beyJ[\w-]{8,}\.[\w-]{8,}\./],
  ['an API key', /\bsk-[A-Za-z0-9_-]{16,}/],
  ['a bearer credential', /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/],
  ['a GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ['a Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['an AWS key id', /\bAKIA[0-9A-Z]{16}\b/],
];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const PATHS = [
  ['an owner path', /\/(Users|home)\/(?!user(\/|\b))[^/\s"']+/],
  ['a volume path', /\/Volumes\/(?!volume(\/|\b))[^/\s"']+/],
  ['a Windows profile path', /[A-Za-z]:\\+Users\\+/],
  ['a home-relative path', /(^|[\s"'=:])~\//],
];
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const SYNTHETIC_UUID = /^[0-9a-f]{8}-0000-7000-8000-00000000[0-9a-f]{4}$/i;
const PLACEHOLDER = (v) => v === null || v === '' || v === '<redacted>' || v === false || v === 0;

/**
 * Every place a value breaks a sanitization rule: [{ path, rule, message }]. The message never repeats the value (only its rule and where it is).
 * @param {unknown} value  a capture, a trace, or any part of one
 */
export function sanitizationIssues(value, path = '$') {
  const out = [];
  const visitString = (s, at) => {
    for (const [what, re] of TOKEN_SHAPES) if (re.test(s)) out.push({ path: at, rule: 'S1', message: `${what}` });
    if (EMAIL.test(s)) out.push({ path: at, rule: 'S2', message: 'an e-mail address' });
    for (const [what, re] of PATHS) if (re.test(s)) out.push({ path: at, rule: 'S3', message: what });
    for (const u of s.match(UUID) ?? []) if (!SYNTHETIC_UUID.test(u)) { out.push({ path: at, rule: 'S4', message: 'a UUID that is not synthetic (xxxxxxxx-0000-7000-8000-00000000nnnn)' }); break; }
  };
  const visit = (v, at) => {
    if (typeof v === 'string') return visitString(v, at);
    if (Array.isArray(v)) return v.forEach((x, i) => visit(x, `${at}[${i}]`));
    if (!isObject(v)) return;
    for (const [k, x] of Object.entries(v)) {
      const here = `${at}.${k}`;
      visitString(k, `${here} (key)`);
      if (CREDENTIAL_KEY.test(k) && !PLACEHOLDER(x) && !(isObject(x) || Array.isArray(x))) out.push({ path: here, rule: 'S1', message: 'a value under a credential key' });
      if (ACCOUNT_KEY.test(k) && !PLACEHOLDER(x)) out.push({ path: here, rule: 'S2', message: 'a value under an account key' });
      visit(x, here);
    }
  };
  visit(value, path);
  return out;
}

/**
 * A sanitized deep copy of recorded traffic (the first pass of recording a capture; `sanitizationIssues` must then find nothing, and a person reads the
 * result before it is committed): S1 values under credential keys and token-shaped strings become "<redacted>"; S2 e-mail addresses become
 * "<redacted-email>" and values under account keys "<redacted>"; S3 `/Users/<name>` and `/home/<name>` become `/Users/user`, a volume `/Volumes/volume`;
 * S4 every UUID becomes a synthetic one, numbered in order of first appearance (the same UUID always maps to the same number, so grouping survives).
 */
export function sanitizeCapture(value) {
  const ids = new Map();
  const synth = (u) => {
    const k = u.toLowerCase();
    if (SYNTHETIC_UUID.test(k)) return k;
    if (!ids.has(k)) ids.set(k, `019a0000-0000-7000-8000-${(ids.size + 1).toString(16).padStart(12, '0')}`);
    return ids.get(k);
  };
  const str = (s) => {
    let out = s;
    for (const [, re] of TOKEN_SHAPES) out = out.replace(new RegExp(re.source, 'g'), '<redacted>');
    out = out.replace(new RegExp(EMAIL.source, 'g'), '<redacted-email>');
    out = out.replace(/\/(Users|home)\/(?!user(\/|\b))[^/\s"']+/g, '/Users/user').replace(/\/Volumes\/(?!volume(\/|\b))[^/"'\n]+/g, '/Volumes/volume').replace(/[A-Za-z]:\\+Users\\+[^\\\s"']+/g, 'C:\\Users\\user');
    return out.replace(UUID, synth);
  };
  const walk = (v) => {
    if (typeof v === 'string') return str(v);
    if (Array.isArray(v)) return v.map(walk);
    if (!isObject(v)) return v;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [str(k), (CREDENTIAL_KEY.test(k) || ACCOUNT_KEY.test(k)) && !PLACEHOLDER(x) && !isObject(x) && !Array.isArray(x) ? '<redacted>' : walk(x)]));
  };
  return walk(value);
}

// ------------------------------------------------------------------------------------------------ loading
/**
 * Every way a capture breaks its format, its build's protocol or the sanitization rules: [{ path, message }].
 * @param {object} c  a parsed capture
 */
export function captureIssues(c) {
  const issues = [];
  const bad = (path, message) => issues.push({ path, message });
  if (!isObject(c)) return [{ path: '$', message: 'a capture is an object' }];
  if (c.format !== CAPTURE_FORMAT) bad('$.format', `is ${CAPTURE_FORMAT}`);
  if (typeof c.build !== 'string' || !/^\d+\.\d+\.\d+-\d+$/.test(c.build)) bad('$.build', 'is the app build it was recorded on, such as 26.1007.30912-20156');
  if (typeof c.recorded !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(c.recorded)) bad('$.recorded', 'is the day it was recorded (YYYY-MM-DD)');
  if (typeof c.source !== 'string' || !c.source) bad('$.source', 'names the QA record it came from');
  if (typeof c.doc !== 'string' || !c.doc) bad('$.doc', 'says what was done while recording and what the capture leaves out');
  if (!Array.isArray(c.sanitized) || !['S1', 'S2', 'S3', 'S4'].every((r) => c.sanitized.includes(r))) bad('$.sanitized', 'lists the rules applied: S1, S2, S3 and S4');
  let methods = null;
  if (!issues.some((i) => i.path === '$.build')) { try { methods = protocolMethods(c.build); } catch (e) { bad('$.build', e.message); } }
  if (!isObject(c.sessions) || !Object.keys(c.sessions).length) bad('$.sessions', 'holds one script per app session, by label');
  for (const [label, script] of Object.entries(isObject(c.sessions) ? c.sessions : {})) {
    if (!Array.isArray(script)) { bad(`$.sessions.${label}`, 'is a list of steps'); continue; }
    script.forEach((s, i) => {
      const at = `$.sessions.${label}[${i}]`;
      if (!isObject(s)) return bad(at, 'a step is an object');
      const kinds = STEP_KINDS.filter((k) => k in s);
      if (kinds.length !== 1) return bad(at, `a step is exactly one of ${STEP_KINDS.join(', ')}`);
      const kind = kinds[0], method = s[kind];
      if (typeof method !== 'string' || !method) return bad(`${at}.${kind}`, 'is a method name');
      if ('params' in s && !isObject(s.params) && !Array.isArray(s.params)) bad(`${at}.params`, 'is the params (an object)');
      if ('synthetic' in s && (typeof s.synthetic !== 'string' || !s.synthetic)) bad(`${at}.synthetic`, 'says why the step is reconstructed');
      if (kind === 'client' && ('result' in s) === ('error' in s)) bad(at, 'a client request is answered with exactly one of result or error');
      if (kind === 'client' && 'error' in s && !(isObject(s.error) && Number.isInteger(s.error.code) && typeof s.error.message === 'string')) bad(`${at}.error`, 'is { code, message }');
      if (kind === 'notify' && !('params' in s)) bad(`${at}.params`, 'a notification carries its params');
      if (methods) {
        const known = { client: methods.clientRequest, clientNotification: methods.clientNotification, notify: methods.serverNotification, serverRequest: methods.serverRequest }[kind];
        if (!known.has(method)) bad(`${at}.${kind}`, `'${method}' is not a ${kind === 'client' ? 'client request' : kind === 'notify' ? 'server notification' : kind === 'serverRequest' ? 'server request' : 'client notification'} of build ${c.build}`);
      }
    });
  }
  for (const s of sanitizationIssues(c)) bad(s.path, `${s.rule}: ${s.message}`);
  return issues;
}

/** Load a capture file, refusing one with any issue (the message lists them). */
export function loadCapture(file) {
  const c = JSON.parse(readFileSync(file, 'utf8'));
  const issues = captureIssues(c);
  if (issues.length) throw new Error(`${file} is not a usable capture:\n${issues.map((i) => `  ${i.path}: ${i.message}`).join('\n')}`);
  return c;
}

/**
 * The script of the session a fake process plays. With a claims directory (several app sessions whose backends share a --name, as every app session's
 * primary does), each process claims the first session not yet claimed whose label is its name or starts with `<name>.` (`primary.1`, `primary.2`, in
 * order), so the sessions go to the processes in the order they start. Without one: the session by its label, else the "*" one, else the only one.
 */
export function sessionScript(c, label, claimsDir) {
  if (claimsDir) {
    const nat = (a, b) => a.localeCompare(b, 'en', { numeric: true });
    const candidates = Object.keys(c.sessions).filter((l) => l === label || l.startsWith(`${label}.`)).sort(nat);
    for (const l of candidates) {
      try { mkdirSync(join(claimsDir, encodeURIComponent(l)), { recursive: false }); return { label: l, script: c.sessions[l] }; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    throw new Error(`the capture has no unclaimed session for '${label}' (it has ${Object.keys(c.sessions).join(', ')})`);
  }
  if (Object.hasOwn(c.sessions, label)) return { label, script: c.sessions[label] };
  if (Object.hasOwn(c.sessions, '*')) return { label: '*', script: c.sessions['*'] };
  const labels = Object.keys(c.sessions);
  if (labels.length === 1) return { label: labels[0], script: c.sessions[labels[0]] };
  throw new Error(`the capture has no session '${label}' (it has ${labels.join(', ')})`);
}

/** Does `actual` contain `expected` (deep): every key `expected` names is equal in `actual`; arrays equal item by item; "$any" matches anything. */
export function contains(actual, expected) {
  if (expected === '$any') return actual !== undefined;
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((x, i) => contains(actual[i], x));
  if (isObject(expected)) return isObject(actual) && Object.entries(expected).every(([k, x]) => contains(actual[k], x));
  return Object.is(actual, expected);
}

/**
 * The environment that makes the fake app-server replay a capture. Each process picks its session by its --name; with `claimsDir` (an empty directory
 * the test owns), processes that share a name take the sessions `<name>.1`, `<name>.2`, ... in the order they start.
 */
export const replayEnv = (file, claimsDir) => ({ FAKE_APP_SERVER_CAPTURE: file, ...(claimsDir ? { FAKE_APP_SERVER_CLAIMS: claimsDir } : {}) });
