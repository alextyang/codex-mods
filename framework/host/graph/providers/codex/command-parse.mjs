// A command as a policy reads it (docs/design/public-hooks.md §4 F3, CommandApproval.parsed; scout H5-data §4): the app-server asks with
// the command as it will run (often `/bin/zsh -lc '<the command>'`) and its own best-effort actions (read, list, search, unknown, "for
// friendly display"). This splits the command the way a shell would read its first simple command: the wrapper taken off, quotes and
// escapes undone, and `compound` when the command goes on past it (a pipe, `&&`, `;`, a redirect, a subshell or a substitution). `readOnly`
// says every action the app-server named is a read, a listing or a search and nothing writes through a redirect: advisory, never a proof.
// Node built-ins only (none needed).

const WRAPPER = /^\s*((?:\S*\/)?(?:bash|zsh|sh|dash|fish))\s+(-[A-Za-z]*c[A-Za-z]*)\s+([\s\S]+)$/;
const OPERATORS = new Set(['|', '&', ';', '<', '>', '(', ')', '\n']);

/** A shell wrapper's inner command (`zsh -lc 'ls -la'` -> `ls -la`, wrapped `zsh -lc`), or the command as it is. */
export function unwrapShell(command) {
  const m = WRAPPER.exec(String(command ?? ''));
  if (!m) return { inner: String(command ?? '').trim(), wrapped: null };
  const { tokens, rest } = tokenize(m[3]);
  // the wrapper's one argument (quoted as one word): what it runs
  if (tokens.length >= 1 && !rest.trim()) return { inner: tokens[0], wrapped: `${m[1].split('/').pop()} ${m[2]}` };
  return { inner: m[3].trim(), wrapped: `${m[1].split('/').pop()} ${m[2]}` };
}

/**
 * The words of the first simple command of `text` (quotes and escapes undone), whether it goes on past them (`compound`), whether a write
 * redirect is in it (`>`), and the text after the first operator (`rest`).
 */
export function tokenize(text) {
  const s = String(text ?? '');
  const tokens = [];
  let cur = null, i = 0, compound = false;
  const push = () => { if (cur !== null) tokens.push(cur); cur = null; };
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { cur = (cur ?? '') + s[i + 1]; i += 2; continue; }
    if (c === "'") { const end = s.indexOf("'", i + 1); const stop = end < 0 ? s.length : end; cur = (cur ?? '') + s.slice(i + 1, stop); i = stop + 1; continue; }
    if (c === '"') {
      let j = i + 1, out = '';
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\' && j + 1 < s.length && '"\\$`'.includes(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
        if (s[j] === '`' || (s[j] === '$' && s[j + 1] === '(')) compound = true;
        out += s[j]; j++;
      }
      cur = (cur ?? '') + out; i = j + 1; continue;
    }
    if (c === '`' || (c === '$' && s[i + 1] === '(')) { compound = true; cur = (cur ?? '') + c; i++; continue; }
    if (/\s/.test(c) && c !== '\n') { push(); i++; continue; }
    if (OPERATORS.has(c)) {
      if ((c === '>' || c === '<') && cur !== null && /^\d+$/.test(cur)) cur = null;   // `2>&1`: the stream it redirects, not a word
      push();
      // the first command ends here (a redirect of its own output too): what follows is more than one simple command
      return { tokens, compound: true, redirect: writes(s.slice(i)), rest: s.slice(i) };
    }
    cur = (cur ?? '') + c; i++;
  }
  push();
  return { tokens, compound, redirect: false, rest: '' };
}

/** Does the text write through a redirect outside quotes (`> file`, `>> file`; not `2>&1`, which sends one stream to another)? */
function writes(text) {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === "'") { const end = text.indexOf("'", i + 1); i = end < 0 ? text.length : end; continue; }
    if (c === '"') { let j = i + 1; while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1; i = j; continue; }
    if (c === '>' && text[i + 1] !== '&' && !(text[i + 1] === '>' && text[i + 2] === '&')) return true;
  }
  return false;
}

const ACTION_KINDS = { read: 'read', listFiles: 'list', search: 'search', unknown: 'unknown' };
/** The app-server's actions as the graph names them. */
export function actionsOf(commandActions) {
  return (Array.isArray(commandActions) ? commandActions : []).filter((a) => a && typeof a === 'object').map((a) => ({
    kind: ACTION_KINDS[a.type] ?? 'unknown', command: String(a.command ?? ''),
    ...(typeof a.path === 'string' && a.path ? { path: a.path } : {}), ...(typeof a.name === 'string' && a.name ? { name: a.name } : {}),
    ...(typeof a.query === 'string' && a.query ? { query: a.query } : {}),
  }));
}

/** `{program, args, compound, wrapped?, readOnly, actions}` for a command and the app-server's actions for it. */
export function parseCommand(command, commandActions) {
  const { inner, wrapped } = unwrapShell(command);
  const { tokens, compound, redirect } = tokenize(inner);
  const actions = actionsOf(commandActions);
  return {
    program: tokens[0] ?? '', args: tokens.slice(1), compound, ...(wrapped ? { wrapped } : {}),
    readOnly: actions.length > 0 && actions.every((a) => a.kind !== 'unknown') && !redirect,
    actions,
  };
}
