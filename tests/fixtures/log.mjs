// Test logger implementing contracts/host.d.ts Log. Records entries for assertions.
export function createTestLog(scope = 'test', entries = []) {
  const at = (level) => (msg, data) => entries.push({ scope, level, msg, data });
  return { entries, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'),
    child: (s) => createTestLog(`${scope}/${s}`, entries) };
}
