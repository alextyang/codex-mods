// codexmods keygen [--out <pem>]: a new ed25519 publisher key.
import { open } from 'node:fs/promises';
import { absPath, err, out, parse, printJson } from '../lib/args.mjs';
import { EXIT, guarded } from '../lib/run.mjs';
import { loadPackModule } from '../lib/packmod.mjs';
import { publisherFingerprint } from '../../contracts/layout.mjs';

export const USAGE = `codexmods keygen [--out <file>] [--json]

Creates an ed25519 publisher key. With --out the private key (PEM) is written to <file> with mode 0600 and never
overwrites an existing file. Without --out the PEM is printed on stdout. The public key and its fingerprint are
what users see at consent.`;

export async function run(argv, io) {
  return guarded(io, async () => {
    const { values, positionals } = parse(argv, { out: { type: 'string' } });
    if (values.help) { out(io, USAGE); return EXIT.ok; }
    if (positionals.length) { err(io, USAGE); return EXIT.usage; }
    const { keygen } = await loadPackModule(io);
    const { publicKey, privateKeyPem } = await keygen();
    const fingerprint = publisherFingerprint(publicKey);
    if (values.out) {
      const target = absPath(io, values.out);
      const fh = await open(target, 'wx', 0o600);
      try { await fh.writeFile(privateKeyPem); } finally { await fh.close(); }
      if (values.json) printJson(io, { publicKey, fingerprint, privateKeyFile: target });
      else { out(io, `Private key written to ${target} (keep it secret)`); out(io, `Public key:   ${publicKey}`); out(io, `Fingerprint:  ${fingerprint}`); }
    } else if (values.json) {
      printJson(io, { publicKey, fingerprint, privateKeyPem });
    } else {
      out(io, privateKeyPem);
      err(io, `Public key:   ${publicKey}\nFingerprint:  ${fingerprint}`);
    }
    return EXIT.ok;
  });
}
