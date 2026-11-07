// A stand-in for the `claude` program, for codexmods.claude-code's tests and the QA copy's native check (no model traffic). It speaks
// stream-json as Claude Code 2.1 does with `-p --input-format stream-json --output-format stream-json --include-partial-messages
// --permission-prompt-tool stdio` (recorded 2026-11-06): `system/init` with the session id, the answer as `stream_event` text deltas then
// the `assistant` message, a tool call as a `tool_use` block, its permission asked as `control_request can_use_tool` and answered on its
// input, the tool's `tool_result`, then `result`. An interrupt is answered (`control_response`), followed by "[Request interrupted by
// user]", and the program ends (exit 1), as Claude Code does.
//
// What it does depends on the message: "run" asks to run `echo hi` (Bash); "edit" asks to change notes.txt in its folder (Edit); "count"
// streams numbers until it is interrupted; anything else is answered "Hello from <model>". FAKE_CLAUDE_LOG, when set, gets a line per start
// ({args, cwd}).
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const sessionId = flag('--resume') ?? flag('--session-id') ?? randomUUID();
const model = flag('--model') ?? 'sonnet';
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ args, cwd: process.cwd() })}\n`);

const out = (o) => process.stdout.write(`${JSON.stringify({ ...o, session_id: sessionId })}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waiting = new Map();   // request id -> resolve(response)
let inited = false, interrupted = false, seq = 0;

const delta = (text) => out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
async function say(text) {
  for (const piece of text.match(/.{1,6}/gs) ?? []) { delta(piece); await sleep(5); }
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
}
async function tool(name, input, run) {
  const id = `toolu_${++seq}`;
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
  const rid = randomUUID();
  const answer = new Promise((r) => waiting.set(rid, r));
  out({ type: 'control_request', request_id: rid, request: { subtype: 'can_use_tool', tool_name: name, display_name: name, input, description: input.description ?? name, tool_use_id: id } });
  const res = await answer;
  if (res?.behavior === 'allow') {
    out({ type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: run(), is_error: false }] } });
    return true;
  }
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: res?.message ?? 'denied', is_error: true }] } });
  return false;
}
const result = (text) => out({ type: 'result', subtype: 'success', is_error: false, result: text, duration_ms: 1, num_turns: 1 });

async function turn(text) {
  if (!inited) { inited = true; out({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sessionId, model, tools: ['Bash', 'Edit', 'Write', 'Read'] }); }
  if (/\brun\b/i.test(text)) {
    const ran = await tool('Bash', { command: 'echo hi', description: 'Say hi' }, () => 'hi');
    await say(ran ? 'Ran it.' : 'Not run.');
    return result(ran ? 'Ran it.' : 'Not run.');
  }
  if (/\bedit\b/i.test(text)) {
    const done = await tool('Edit', { file_path: join(process.cwd(), 'notes.txt'), old_string: 'old line', new_string: 'new line' }, () => 'The file has been updated.');
    await say(done ? 'Edited notes.txt.' : 'Left it.');
    return result('done');
  }
  if (/\bcount\b/i.test(text)) {
    for (let n = 1; n <= 2000 && !interrupted; n++) { delta(`${n}\n`); await sleep(20); }
    return undefined;
  }
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'A greeting.', signature: 'x' }] } });
  await say(`Hello from ${model}`);
  return result(`Hello from ${model}`);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'user') void turn((e.message?.content ?? []).map((c) => c?.text ?? '').join(''));
    else if (e.type === 'control_response') { const r = waiting.get(e.response?.request_id); waiting.delete(e.response?.request_id); r?.(e.response?.response); }
    else if (e.type === 'control_request' && e.request?.subtype === 'interrupt') {
      interrupted = true;
      process.stdout.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: e.request_id, response: { still_queued: [] } } })}\n`);
      out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
      setTimeout(() => process.exit(1), 20);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
