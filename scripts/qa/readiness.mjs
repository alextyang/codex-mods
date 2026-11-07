// Pure readiness evaluation (ARCHITECTURE §12: the Host answers, the mux has a ready app primary, a boot marker exists).
/**
 * @param {{diagnostics: any|null, boot: any|null, hostPids: Set<number>, launchedAtMs: number}} i
 * @returns {{ready: boolean, checks: Record<string, boolean>, missing: string[]}}
 */
export function evaluateReadiness({ diagnostics, boot, hostPids, launchedAtMs }) {
  const backends = diagnostics?.mux?.backends;
  const checks = {
    hostAnswers: !!diagnostics?.host && Number.isInteger(diagnostics.host.pid),
    hostIsOurs: !!diagnostics?.host && hostPids.has(diagnostics.host.pid), // a stale Host from an earlier run must not count
    appSessionReady: Array.isArray(backends) && backends.some((b) => b.owner === 'app' && b.state === 'ready'),
    bootMarker: !!boot && Number.isInteger(boot.generation) && Date.parse(boot.startedAt) >= launchedAtMs - 2000,
  };
  return { ready: Object.values(checks).every(Boolean), checks, missing: Object.entries(checks).filter(([, v]) => !v).map(([k]) => k) };
}

/** Strict isolation re-checks after readiness, so services that start after sign-in (the Computer Use helper) are covered. */
export const LATE_CHECK_OFFSETS_MS = [20000, 45000];
/**
 * @param {number} readyAtMs when readiness was reached
 * @param {number} nowMs
 * @param {number[]} offsets
 * @returns {{atMs: number, waitMs: number, offsetMs: number}[]} the checks still to run, with the wait before each (never negative)
 */
export function planLateChecks(readyAtMs, nowMs, offsets = LATE_CHECK_OFFSETS_MS) {
  return offsets.map((offsetMs) => ({ offsetMs, atMs: readyAtMs + offsetMs, waitMs: Math.max(0, readyAtMs + offsetMs - nowMs) }));
}
