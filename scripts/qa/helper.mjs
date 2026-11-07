// The app copies its Computer Use helper into <CODEX_HOME>/computer-use/ and records SKY_CUA_SERVICE_PATH in config.toml, then reuses
// that copy across rebuilds. A helper copied from an unpatched build carries the stock container id and defeats the copy's rename
// (ARCHITECTURE v1.11), so QA setup removes it. Pure classification here; the walk and removal are in commands.mjs.
export const RENAMED_ID = 'com.openai.sky.CUAServicf';
export const STOCK_ID = 'com.openai.sky.CUAService';

/**
 * @param {{rel: string, bytes: Buffer}[]} files Info.plist files and Mach-O binaries of the copied helper
 * @returns {{state: 'empty'|'renamed'|'stale', renamedIn: string[], stockIn: string[]}}
 *   renamed: some file carries the renamed id and none carries the stock id. Anything else is stale (conservative: remove).
 */
export function classifyHelper(files) {
  const renamedIn = []; const stockIn = [];
  const renamed = Buffer.from(RENAMED_ID); const stock = Buffer.from(STOCK_ID);
  for (const f of files) {
    if (f.bytes.includes(renamed)) renamedIn.push(f.rel);
    if (f.bytes.includes(stock)) stockIn.push(f.rel); // "…CUAServicf" does not contain "…CUAService": the last character differs
  }
  if (!files.length) return { state: 'empty', renamedIn, stockIn };
  return { state: renamedIn.length > 0 && stockIn.length === 0 ? 'renamed' : 'stale', renamedIn, stockIn };
}

const MACHO = new Set([0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xfeedface, 0xcefaedfe]);
export const isMachO = (b) => b.length >= 4 && (MACHO.has(b.readUInt32BE(0)) || MACHO.has(b.readUInt32LE(0)));
export const isRelevantFile = (name, head) => name === 'Info.plist' || isMachO(head);
