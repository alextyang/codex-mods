// A mod's Accounts on the app's Account page (public-hooks.md §3.15, H7pc; scout of 2026-10-31: the app signs in to one ChatGPT account
// and lists no other anywhere, so there is no place of the app's for another): the framework's own section after the page's own, in the
// app's SettingsSection with its title, a card with a row per Account of a provider other than Codex: its name, its service and what it
// says of itself (its email or plan, whether it is signed in), and its own Sign in or Sign out, the user's own act
// (the Host invokes it as the user: interceptors and policies see the user's); one that does not go says why on its row. The Accounts are a
// view of the graph's, by instance (a subtype's change replaces its row), followed while the page is open. What an account's usage holds is
// its provider's own (graph-boundary.md B3): a mod that shows it decorates its row. NO NODE API.

/** What a row says of an Account: its service, its email or plan, and whether it is signed in. */
export function accountLine(inst) {
  const s = inst?.state ?? {};
  return [s.service, s.email ?? s.plan, s.signedIn ? 'Signed in' : 'Signed out'].filter((x) => typeof x === 'string' && x).join(' · ');
}
/** What a row says of a Sign in or Sign out that did not go: its outcome's reason; null when it went. */
export function notDone(op, out) {
  if (!out || out.status === 'done') return null;
  const what = op === 'signOut' ? 'Sign out' : 'Sign in';
  const why = out.message ?? out.error?.message ?? out.reason ?? '';
  return out.status === 'uncertain' ? `${what} may not have finished${why ? `: ${why}` : ''}` : `${what} did not go${why ? `: ${why}` : ''}`;
}

/**
 * The section's component (one per window), or a component that draws nothing when the build lacks the app's settings parts.
 * @param {object} R  React
 * @param {{ exports?: () => object, view: (query: object, fn: (m: object) => void) => { dispose(): void }, subject: (ref: object) => object | undefined,
 *   use: (fn: () => any) => any, userAct: (ref: object, op: string) => Promise<object>, log?: (m: string, d?: object) => void }} ctx
 */
export function createAccountsSection(R, ctx) {
  const e = R.createElement;
  /** The provided Accounts (not Codex's own), followed while the page is open. */
  function useAccounts() {
    const [items, setItems] = R.useState([]);
    R.useEffect(() => {
      let list = new Map();
      const k = (r) => `${r.provider}\u001f${r.id}`;   // the graph's identity: a subtype's change is the same Account
      // eslint-disable-next-line codexmods/no-provider-identity -- the app draws its own account; this section joins the others
      const mine = (x) => !!x?.ref && x.ref.provider !== 'codex' && !x.gone;
      let sub = null;
      try {
        sub = ctx.view({ type: 'Account', depth: 'core' }, (m) => {
          if (!m) return;
          if (m.type === 'snapshot') list = new Map((m.items ?? []).filter(mine).map((x) => [k(x.ref), x]));
          // eslint-disable-next-line codexmods/no-provider-identity -- the app draws its own account; this section joins the others
          else if (m.type === 'delta' && m.event?.ref && m.event.kind !== 'event' && m.event.ref.provider !== 'codex') {
            if (m.event.kind === 'removed' || !mine(m.event.instance)) { if (!list.delete(k(m.event.ref))) return; } else list.set(k(m.event.ref), m.event.instance);
          } else return;
          setItems([...list.values()]);
        });
      } catch (err) { ctx.log?.('the mods\' accounts cannot be followed', { message: String(err?.message ?? err) }); }
      return () => sub?.dispose();
    }, []);
    return items;
  }
  function Row({ account }) {
    const ex = ctx.exports?.() ?? {};
    const Row0 = ex.SettingsRow, Button = ex.Button;
    const [busy, setBusy] = R.useState(false);
    const [note, setNote] = R.useState(null);
    const signedIn = !!account.state?.signedIn;
    R.useEffect(() => { setNote(null); }, [signedIn]);
    if (!Row0 || !Button) return null;
    const op = signedIn ? 'signOut' : 'signIn';
    const act = async () => {
      setBusy(true); setNote(null);
      let out;
      try { out = await ctx.userAct(account.ref, op); } catch (err) { out = { status: 'failed', error: { message: String(err?.message ?? err) } }; }
      const said = notDone(op, out);
      if (said) { setNote(said); ctx.log?.('an account was not changed', { op, out }); }
      setBusy(false);
    };
    const control = e(Button, { color: 'secondary', disabled: busy, onClick: () => { void act(); }, 'data-codexmods-account': `${account.ref.provider}/${account.ref.id}` }, op === 'signOut' ? 'Sign out' : 'Sign in');
    const line = accountLine(account);
    return e(Row0, { label: String(account.state?.name ?? account.ref.id), description: note ? `${line} — ${note}` : line, control });
  }
  return function AccountsSection() {
    const accounts = useAccounts();
    const ex = ctx.exports?.() ?? {};
    const S = ex.SettingsSection, Card = ex.SettingsCard;
    if (!accounts.length || !S?.Header || !S.Content || !Card) return null;
    return e(S, { 'data-codexmods-framework': 'accounts' }, e(S.Header, { title: 'Accounts from mods' }),
      e(S.Content, null, e(Card, null, ...accounts.map((a) => e(Row, { key: `${a.ref.provider}/${a.ref.id}`, account: a })))));
  };
}
