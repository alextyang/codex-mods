// Human-readable output helpers.
export function table(rows, columns) {
  const cells = rows.map((r) => columns.map((c) => String(c.get(r) ?? '')));
  const widths = columns.map((c, i) => Math.max(c.title.length, ...cells.map((row) => row[i].length)));
  const line = (vals) => vals.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd();
  return [line(columns.map((c) => c.title)), ...cells.map(line)].join('\n');
}

export function opSummary(op) {
  const target = op.input.modId ?? op.input.source ?? op.input.candidate ?? op.input.version ?? '';
  return `${op.id}  ${op.input.type}${target ? ` ${target}` : ''}  ${op.outcome}`;
}

/** Final text for an operation: outcome plus note or error, and the consent hint. */
export function opOutcomeText(op) {
  const lines = [opSummary(op)];
  if (op.error) lines.push(`  error [${op.error.code}]: ${op.error.message}`);
  if (op.note) lines.push(`  ${op.note}`);
  if (op.awaiting === 'consent') {
    lines.push(`  Consent required: codexmods mods consent ${op.input.modId ?? '<modId>'} --approve [--enable]  (or --deny)`);
  }
  return lines.join('\n');
}

export function ago(iso, nowMs = Date.now()) {
  const s = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export const bytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1048576).toFixed(1)} MiB`);
