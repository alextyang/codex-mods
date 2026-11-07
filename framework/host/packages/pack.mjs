// Packing and signing (.codexmod). `keygen()` and `packMod(dir, privateKeyPem, outPath)`.
// Archive layout: mod.json, the package files and signature.json {contentHash, signature} at the root.
// Signature: ed25519 over the UTF-8 contentHash string (hash rules in hash.mjs).
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, randomBytes } from 'node:crypto';
import { open, rename, rm, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CodexModsError } from '../../../sdk/errors.mjs';
import { writeZip } from '../../shared/zip.mjs';
import { validateManifest, referencedFiles } from './manifest.mjs';
import { contentHashOf, readPackageDir, SIGNATURE_FILE } from './hash.mjs';

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Raw 32-byte public key (base64) of an ed25519 KeyObject. */
export function rawPublicKey(keyObject) {
  const pubKey = keyObject.type === 'private' ? createPublicKey(keyObject) : keyObject;
  const der = pubKey.export({ type: 'spki', format: 'der' });
  return der.subarray(der.length - 32).toString('base64');
}

/** KeyObject from a base64 raw 32-byte ed25519 public key. */
export function publicKeyFromRaw(base64) {
  const raw = Buffer.from(base64, 'base64');
  if (raw.length !== 32) throw new CodexModsError('Invalid', 'publisher: not a 32-byte ed25519 key');
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: 'der', type: 'spki' });
}

export function signContentHash(contentHash, privateKey) {
  return edSign(null, Buffer.from(contentHash, 'utf8'), privateKey).toString('base64');
}

export function verifyContentHash(contentHash, signatureBase64, publisherBase64) {
  try {
    return edVerify(null, Buffer.from(contentHash, 'utf8'), publicKeyFromRaw(publisherBase64), Buffer.from(signatureBase64, 'base64'));
  } catch { return false; }
}

/** @returns {{publicKey: string, privateKeyPem: string}} publicKey is base64 of the raw 32 bytes. */
export function keygen() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey: rawPublicKey(publicKey), privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

/**
 * Packs `dir` into a signed .codexmod at `outPath`.
 * - validates mod.json and that every file it references exists;
 * - sets `publisher` from the key when absent, refuses when it names a different key;
 * - hashes every file except signature.json, signs, writes the archive atomically.
 * @returns {Promise<{outPath: string, contentHash: string, publisher: string, manifest: object}>}
 */
export async function packMod(dir, privateKeyPem, outPath) {
  let privateKey;
  try { privateKey = createPrivateKey(privateKeyPem); } catch { throw new CodexModsError('Invalid', 'privateKeyPem: not a valid private key'); }
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new CodexModsError('Invalid', 'privateKeyPem: must be an ed25519 key');
  const publisher = rawPublicKey(privateKey);

  const files = (await readPackageDir(dir)).filter((f) => f.path !== SIGNATURE_FILE);
  const modEntry = files.find((f) => f.path === 'mod.json');
  if (!modEntry) throw new CodexModsError('Invalid', 'mod.json: file not found in package');
  let parsed;
  try { parsed = JSON.parse(modEntry.data.toString('utf8')); } catch (e) { throw new CodexModsError('Invalid', `mod.json: not valid JSON (${e.message})`); }
  if (parsed && typeof parsed === 'object' && parsed.publisher !== undefined && parsed.publisher !== publisher) {
    throw new CodexModsError('Invalid', 'publisher: mod.json names a different key than the signing key');
  }
  const manifest = validateManifest({ ...parsed, publisher });
  const present = new Set(files.map((f) => f.path));
  for (const [at, rel] of referencedFiles(manifest)) if (!present.has(rel)) throw new CodexModsError('Invalid', `${at}: file not found in package`);

  if (parsed.publisher === undefined) {
    modEntry.data = Buffer.from(JSON.stringify({ ...parsed, publisher }, null, 2) + '\n', 'utf8');
  }
  const contentHash = contentHashOf(files);
  const signature = signContentHash(contentHash, privateKey);
  const entries = [...files, { path: SIGNATURE_FILE, data: JSON.stringify({ contentHash, signature }, null, 2) + '\n', mode: 0o644 }]
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const zip = writeZip(entries.map((f) => ({ path: f.path, data: f.data, mode: f.mode ?? 0o644 })));

  await mkdir(dirname(outPath), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(outPath), `.${randomBytes(6).toString('hex')}.tmp`);
  const fh = await open(tmp, 'w', 0o600);
  try { await fh.writeFile(zip); await fh.sync(); } finally { await fh.close(); }
  try { await rename(tmp, outPath); } catch (e) { await rm(tmp, { force: true }); throw e; }
  return { outPath, contentHash, publisher, manifest };
}
