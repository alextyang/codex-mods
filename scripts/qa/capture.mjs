#!/usr/bin/env node
// Turns a qa.record recording (frames.jsonl, raw, on the QA machine) into a sanitized capture (tests/fixtures/captures.mjs,
// codexmods.capture/1) for the strict fake app-server. Run as the QA user next to the recording; it prints the capture on stdout and refuses
// to print one that breaks the format or a sanitization rule (S1 to S4). A person reads the result before it is committed.
//
//   node scripts/qa/capture.mjs --frames <frames.jsonl> (--session <n> | --client <client:id>) --source <QA record> --doc <text>
//                               [--build 26.1013.40934-20770] [--from <i>] [--to <i>] [--label primary]
//
// What it keeps: the frames of one app session (by the session number the mux gives each app connection, origin `app`) or of one lease
// client (`--client client:<leaseId>`), between frame indexes --from and --to.
// How it pairs: a client request becomes a `client` step at its arrival, answered by its response (`result` or `error`); a server request
// becomes a `serverRequest` step answered by the client's response (`answer`, results only); notifications become `notify` and
// `clientNotification` steps. Request ids are dropped (the fake answers with the client's id). Format /1 has no concurrency: a request's
// answer is attached to its step, so notifications that arrived while it was in flight replay after it.
// A slice that does not start with the session's initialize gets the session's recorded initialize prepended as a step marked `synthetic`
// (a lease client's initialize is answered by the mux itself from a session's handshake, so it never reaches the recording; the first
// recorded initialize answer stands in for it). A request without an answer in the
// slice is refused, as is any gap.
import { readFileSync } from 'node:fs';
import { captureIssues, sanitizeCapture, CAPTURE_FORMAT } from '../../tests/fixtures/captures.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const framesFile = opt('frames');
const sessionArg = opt('session');
const clientArg = opt('client');
const build = opt('build', '26.1013.40934-20770');
const from = Number(opt('from', 0));
const to = Number(opt('to', Infinity));
const label = opt('label', 'primary');
const source = opt('source');
const doc = opt('doc');
const die = (m) => { process.stderr.write(`capture: ${m}\n`); process.exit(2); };
if (!framesFile || (!sessionArg && !clientArg) || !source || !doc) die('usage: --frames <file> (--session <n> | --client <client:id>) --source <record> --doc <text>');

const frames = readFileSync(framesFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const mine = (f) => (clientArg ? f.origin === clientArg : f.origin === 'app' && f.session?.id === Number(sessionArg));
if (frames.some((f) => f.gap && f.i >= from && f.i <= to)) die('the recording has a gap in the slice: record again');

const steps = [];
const pendingClient = new Map(); // request id -> step
const pendingServer = new Map(); // s:N -> step
let sawInitialize = false;
let preInit = null; // the session's initialize, recorded before the slice
let anyInitResult = null; // the first initialize answer of any session (what the mux replays to a lease client)
for (const f of frames) {
  if (!f.gap && anyInitResult === null && f.kind === 'serverResponse' && f.method === 'initialize' && f.msg?.result) anyInitResult = f.msg.result;
  if (f.gap || !mine(f)) continue;
  if (f.msg?.redacted) die(`frame ${f.i} (${f.method}) carries credentials and was redacted: leave it out of the slice`);
  if (f.i < from || f.i > to) {
    if (f.i < from && f.kind === 'clientRequest' && f.method === 'initialize') preInit = { client: 'initialize', params: f.msg.params };
    if (f.i < from && f.kind === 'serverResponse' && f.method === 'initialize' && preInit) preInit.result = f.msg.result;
    continue;
  }
  const m = f.msg;
  switch (f.kind) {
    case 'clientRequest': {
      const step = { client: f.method, ...(m.params === undefined ? {} : { params: m.params }) };
      if (f.method === 'initialize') sawInitialize = true;
      steps.push(step);
      pendingClient.set(m.id, step);
      break;
    }
    case 'serverResponse': {
      const step = pendingClient.get(m.id);
      if (!step) break; // answered request from before the slice
      pendingClient.delete(m.id);
      if (m.error !== undefined) step.error = { code: m.error.code, message: m.error.message }; else step.result = m.result ?? null;
      break;
    }
    case 'clientNotification': steps.push({ clientNotification: f.method, ...(m.params === undefined ? {} : { params: m.params }) }); break;
    case 'serverNotification': steps.push({ notify: f.method, params: m.params ?? {} }); break;
    case 'serverRequest': {
      const step = { serverRequest: f.method, params: m.params ?? {} };
      steps.push(step);
      pendingServer.set(m.id, step);
      break;
    }
    case 'clientResponse': {
      const step = pendingServer.get(m.id);
      if (!step) break;
      pendingServer.delete(m.id);
      if (m.result !== undefined) step.answer = m.result;
      break;
    }
    default: break;
  }
}
if (pendingClient.size) die(`${pendingClient.size} request(s) have no answer in the slice (${[...pendingClient.values()].map((s) => s.client).join(', ')}): widen --to`);
if (!sawInitialize) {
  if (!preInit?.result && !clientArg) die('the session\'s initialize is not in the recording: record from the app\'s start');
  if (clientArg && !anyInitResult) die('no initialize answer is in the recording to reconstruct the lease\'s from: record from an app session\'s start');
  const init = preInit?.result ? preInit : { client: 'initialize', params: { clientInfo: { name: 'codexmods-qa', title: null, version: '1' }, capabilities: { experimentalApi: true } }, result: anyInitResult };
  steps.unshift({ ...init, synthetic: clientArg ? 'a lease client\'s initialize is answered by the mux and not recorded; this is the shape the lease sends' : 'the session\'s initialize, recorded before the slice' });
  steps.splice(1, 0, { clientNotification: 'initialized', synthetic: 'follows initialize' });
}

const capture = sanitizeCapture({
  format: CAPTURE_FORMAT, build, recorded: new Date().toISOString().slice(0, 10), source, doc, sanitized: ['S1', 'S2', 'S3', 'S4'],
  sessions: { [label]: steps.filter((s) => s.client !== undefined ? s.result !== undefined || s.error !== undefined : true) },
});
const issues = captureIssues(capture);
if (issues.length) die(`the capture is not usable:\n${issues.map((i) => `  ${i.path}: ${i.message}`).join('\n')}`);
process.stdout.write(`${JSON.stringify(capture, null, 1)}\n`);
