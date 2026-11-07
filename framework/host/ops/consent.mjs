// What waits for the user's consent (docs/design/systems.md "E6 in detail", decision 9): an install or an update, with what it asks. Its
// id hashes those facts, so a consent names what the user reviewed and is refused once something else waits. Node built-ins only.
import { createHash } from 'node:crypto';
import { publisherFingerprint } from '../../../contracts/layout.mjs';

const fp = (key) => (key ? publisherFingerprint(key) : null);
/** F10: the GitHub release a request is for, as its review shows it. */
const releaseOf = (g) => (g ? { source: { repo: g.repo, tag: g.tag, digest: g.digest } } : {});

/** The request of an installed record (and its manifest), or null when nothing waits. */
export function consentRequestOf(record, manifest) {
  if (!record) return null;
  let req = null;
  if (record.pendingUpdate) {
    const pu = record.pendingUpdate;
    const changed = pu.newPublisher !== undefined && pu.newPublisher !== record.publisher;
    const added = [...(pu.addedPermissions ?? [])].sort();
    req = {
      kind: 'update', version: pu.version, publisher: fp(changed ? pu.newPublisher : record.publisher),
      permissions: [...new Set([...(record.grants ?? []), ...added])].sort(), addedPermissions: added,
      ...(changed ? { publisherChange: { from: fp(record.publisher), to: fp(pu.newPublisher) } } : {}),
      // F10: where it comes from now, when that is another repository
      ...(pu.repoChange ? { repoChange: { from: pu.repoChange.from, to: pu.repoChange.to, another: pu.repoChange.another === true } } : {}),
      ...releaseOf(pu.github),
    };
  } else if (record.status === 'pending-consent') {
    const permissions = [...(manifest?.permissions ?? [])].sort();
    req = { kind: 'install', version: record.version, publisher: fp(record.publisher), permissions, addedPermissions: permissions, ...releaseOf(record.source?.kind === 'github' ? record.source : null) };
  }
  if (!req) return null;
  return { id: createHash('sha256').update(JSON.stringify(req)).digest('hex').slice(0, 16), ...req };
}
