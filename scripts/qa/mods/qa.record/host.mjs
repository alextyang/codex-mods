// qa.record — QA only (integration.md §12, release-2.md §4): the raw half of recording a capture. Every frame the mux emits to observers,
// in order, from the boot ring of each live session on, is appended to <dataDir>/files/frames.jsonl (mode 0600) as
// {i, t, kind, method, origin, backend, session, key, msg}. A gap in the stream is written as {i, t, gap} and makes a recording unusable.
// Enabling the mod starts a new file. The file holds unredacted traffic (conversation text included): it never leaves the QA machine;
// scripts/qa/capture.mjs turns a slice of it into a sanitized capture. Frames of the methods whose content can carry credentials are written
// as {redacted: true, method, id} (the mux's own list for its boot ring).
import fs from 'node:fs';
import path from 'node:path';

// The mux's list (framework/host/mux/observers.mjs SECRET_METHODS, which derives from its method classes); a mod cannot import it, so it is
// repeated here and must follow it.
const SECRET_METHODS = new Set([
  'account/login/start', 'account/chatgptAuthTokens/refresh', 'attestation/generate', 'getAuthStatus',
  'account/gatewayOAuth/login', 'account/bedrock/setup', 'mcpServer/oauth/login',
  'environment/add', 'remoteControl/pairing/start', 'remoteControl/pairing/status', 'userVerification/verify',
]);

async function host(ctx) {
  const dir = path.join(ctx.mod.dataDir, 'files');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'frames.jsonl');
  fs.rmSync(file, { force: true });
  const fd = fs.openSync(file, 'a', 0o600);
  let i = 0;
  const write = (o) => { try { fs.writeSync(fd, `${JSON.stringify({ i: i++, t: Date.now(), ...o })}\n`); } catch (e) { ctx.log.warn('qa.record write failed', { message: String(e?.message ?? e) }); } };
  const sub = ctx.appServer.observe({}, (m, info) => {
    if (!info) { write({ gap: m.gap ?? m }); return; }
    const msg = SECRET_METHODS.has(info.method) ? { redacted: true, method: info.method, ...(m && m.id !== undefined ? { id: m.id } : {}) } : m;
    write({ kind: info.kind, method: info.method, origin: info.origin, backend: info.backend, session: info.session ?? null, key: info.affinityKey ?? null, msg });
  }, { queue: 100000, replay: 'boot' });
  ctx.log.info('qa.record active', { file });
  return () => { sub.dispose(); try { fs.closeSync(fd); } catch { /* closed */ } };
}

export default { host };
