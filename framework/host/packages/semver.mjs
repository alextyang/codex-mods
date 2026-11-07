// Tiny semver (SemVer 2.0 incl. +build metadata, which is accepted and ignored for precedence): strict versions and the range subset the manifest allows (">=1 <2", ^, ~, exact, partial versions).
const NUM = '(0|[1-9]\\d*)';
const PRE = '([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)';
const BUILD = '([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)';   // SemVer 2.0 build metadata: carried, never compared
const VERSION_RE = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:-${PRE})?(?:\\+${BUILD})?$`);
const COMPARATOR_RE = new RegExp(`^(>=|<=|>|<|\\^|~|=)?${NUM}(?:\\.${NUM})?(?:\\.${NUM})?(?:-${PRE})?(?:\\+${BUILD})?$`);

export function parseVersion(text) {
  const m = VERSION_RE.exec(String(text));
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null, build: m[5] ?? null };
}

function cmpPre(a, b) {
  if (a === b) return 0;
  if (a === null) return 1;      // a release outranks a prerelease
  if (b === null) return -1;
  const pa = a.split('.'), pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]), nb = /^\d+$/.test(pb[i]);
    if (na && nb) { const d = Number(pa[i]) - Number(pb[i]); if (d) return d < 0 ? -1 : 1; }
    else if (na) return -1;
    else if (nb) return 1;
    else if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

export function compareVersions(a, b) {
  for (const k of ['major', 'minor', 'patch']) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  return cmpPre(a.pre, b.pre);
}

const v = (major, minor, patch, pre = null) => ({ major, minor, patch, pre });

/** Expands one comparator into [{op, version}] bounds, or null when malformed. */
function expand(token) {
  const m = COMPARATOR_RE.exec(token);
  if (!m) return null;
  const op = m[1] ?? '=';
  const major = Number(m[2]);
  const hasMinor = m[3] !== undefined, hasPatch = m[4] !== undefined;
  const minor = hasMinor ? Number(m[3]) : 0, patch = hasPatch ? Number(m[4]) : 0;
  const pre = m[5] ?? null;
  if (pre && !hasPatch) return null;
  const lo = v(major, minor, patch, pre);
  const nextMajor = v(major + 1, 0, 0), nextMinor = v(major, minor + 1, 0), nextPatch = v(major, minor, patch + 1);
  const partialUpper = !hasMinor ? nextMajor : !hasPatch ? nextMinor : null;
  switch (op) {
    case '>=': return [{ op: '>=', version: lo }];
    case '<': return [{ op: '<', version: lo }];
    case '>': return partialUpper ? [{ op: '>=', version: partialUpper }] : [{ op: '>', version: lo }];
    case '<=': return partialUpper ? [{ op: '<', version: partialUpper }] : [{ op: '<=', version: lo }];
    case '=': return partialUpper ? [{ op: '>=', version: lo }, { op: '<', version: partialUpper }] : [{ op: '=', version: lo }];
    case '~': return [{ op: '>=', version: lo }, { op: '<', version: hasMinor ? nextMinor : nextMajor }];
    case '^': {
      let upper;
      if (major > 0 || !hasMinor) upper = nextMajor;
      else if (minor > 0 || !hasPatch) upper = nextMinor;
      else upper = nextPatch;
      return [{ op: '>=', version: lo }, { op: '<', version: upper }];
    }
    default: return null;
  }
}

/** Returns an array of bounds (all must hold), or null when the range is malformed. */
export function parseRange(range) {
  if (typeof range !== 'string') return null;
  const tokens = range.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const bounds = [];
  for (const token of tokens) {
    const parts = expand(token);
    if (!parts) return null;
    bounds.push(...parts);
  }
  return bounds;
}

/** Prerelease tags of `version` are ignored (a 1.0.0-dev framework satisfies ">=1 <2"). */
export function satisfies(version, range) {
  const bounds = parseRange(range);
  const parsed = parseVersion(version);
  if (!bounds || !parsed) return false;
  const core = v(parsed.major, parsed.minor, parsed.patch);
  return bounds.every(({ op, version: b }) => {
    const c = compareVersions(core, b);
    return op === '>=' ? c >= 0 : op === '>' ? c > 0 : op === '<' ? c < 0 : op === '<=' ? c <= 0 : c === 0;
  });
}
