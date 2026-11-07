// Minimal, line-based edit of one boolean key in a TOML table, preserving everything else (comments, order, other tables).
// Handles `[features]` + `computer_use = false` and the dotted top-level form `features.computer_use = false`.
const HEADER = /^\s*\[([^[\]]+)\]\s*(#.*)?$/;
const ARRAY_HEADER = /^\s*\[\[.*\]\]\s*(#.*)?$/;

/**
 * @returns {{text: string, changed: boolean}}
 */
export function ensureTomlBool(text, table, key, value) {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(/\r?\n/);
  if (lines.length && lines.at(-1) === '') lines.pop(); // trailing newline
  const want = `${key} = ${value ? 'true' : 'false'}`;
  const keyRe = new RegExp(`^(\\s*)${key}\\s*=\\s*([^#\\s]+)\\s*(#.*)?$`);
  const dottedRe = new RegExp(`^(\\s*)${table}\\.${key}\\s*=\\s*([^#\\s]+)\\s*(#.*)?$`);
  const finish = (arr, changed) => ({ text: arr.length ? `${arr.join(nl)}${nl}` : '', changed });

  // dotted form anywhere before the first table header
  let firstHeader = lines.findIndex((l) => HEADER.test(l) || ARRAY_HEADER.test(l));
  if (firstHeader < 0) firstHeader = lines.length;
  for (let i = 0; i < firstHeader; i++) {
    const m = dottedRe.exec(lines[i]);
    if (!m) continue;
    if (m[2] === String(!!value)) return { text, changed: false };
    lines[i] = `${m[1]}${table}.${want}${m[3] ? ` ${m[3]}` : ''}`;
    return finish(lines, true);
  }
  // the table
  let start = -1;
  for (let i = 0; i < lines.length; i++) { const m = HEADER.exec(lines[i]); if (m && m[1].trim() === table) { start = i; break; } }
  if (start >= 0) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) if (HEADER.test(lines[i]) || ARRAY_HEADER.test(lines[i])) { end = i; break; }
    for (let i = start + 1; i < end; i++) {
      const m = keyRe.exec(lines[i]);
      if (!m) continue;
      if (m[2] === String(!!value)) return { text, changed: false };
      lines[i] = `${m[1]}${want}${m[3] ? ` ${m[3]}` : ''}`;
      return finish(lines, true);
    }
    let at = end; while (at > start + 1 && lines[at - 1].trim() === '') at -= 1; // before trailing blank lines of the table
    lines.splice(at, 0, want);
    return finish(lines, true);
  }
  if (lines.length && lines.at(-1).trim() !== '') lines.push('');
  lines.push(`[${table}]`, want);
  return finish(lines, true);
}

/**
 * Remove every `key = ...` line (bare or quoted key, any table) and report what was removed. Everything else is preserved.
 * @returns {{text: string, removed: string[]}}
 */
export function removeTomlKeyLines(text, key) {
  const re = new RegExp(`^\\s*"?${key}"?\\s*=`);
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const removed = [];
  const kept = lines.filter((l) => { if (re.test(l)) { removed.push(l.trim()); return false; } return true; });
  return { text: removed.length ? kept.join(nl) : text, removed };
}

/** The (first) string value of `key = "..."` / `key = '...'`, or null. */
export function tomlStringValue(text, key) {
  const m = new RegExp(`^\\s*"?${key}"?\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)')`, 'm').exec(text);
  return m ? (m[1] ?? m[2]) : null;
}
