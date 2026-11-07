// qa.hooks, host realm — QA only (docs/design/public-hooks.md §5): file triggers in <dataDir>/files drive the public hooks as each part
// lands; each trigger's answer goes to <trigger>.out.json. A copy under another id (qa.hooks2) is a second reader.
import fs from 'node:fs/promises';
import path from 'node:path';

export async function host(ctx) {
  const files = path.join(ctx.mod.dataDir, 'files');
  await fs.mkdir(files, { recursive: true });
  const handles = new Map();
  const runs = [];   // the runs of declarations given one (status {run: true}): what the user clicked, with the env's subject
  const keep = async (id, h) => { handles.set(id, h); return { accepted: await h.accepted, places: h.places ?? null, unsupported: h.unsupported ?? null }; };
  const ops = {
    attach: (r) => ctx.graph.attach(r.ref, r.value ?? null, { shared: r.shared === true }),
    attached: (r) => ctx.graph.attached(r.ref),
    list: async (r) => (await ctx.graph.list(r.type, r.where ?? null)).map((x) => ({ ref: x.ref, title: x.summary?.title ?? null, status: x.state?.status ?? null, attached: x.attached ?? null })),
    // `run: true`: each of its actions records its click in runs (with the env's subject)
    decorate: (r) => keep(r.id, ctx.ui.decorate(r.subject ?? 'Thread', { ...r.spec, id: r.id,
      ...(r.run === true && Array.isArray(r.spec?.actions) ? { actions: r.spec.actions.map((a) => ({ ...a, run: (env) => { runs.push({ id: r.id, action: a.id, at: Date.now(), subject: env?.subject ?? null }); } })) } : {}) })),
    // text masked where content is shown (public-hooks.md §3.14, H7u): {spec: {id, match (a pattern's source), as?, sites?}}
    redact: (r) => keep(r.spec.id, ctx.ui.content.redact(r.spec)),
    filter: (r) => keep(r.spec.id, ctx.ui.filter(r.list ?? 'sidebar', r.spec)),
    'filter-on': (r) => handles.get(r.id)?.on(r.window ? { window: r.window } : undefined),
    // an attachment source (ui.composer.attachSource): {spec, attachments} (what its pick gives), each run recorded in runs
    'attach-source': (r) => keep(r.spec.id, ctx.ui.composer.attachSource({ ...r.spec, pick: (env) => { runs.push({ id: r.spec.id, at: Date.now(), env: env ?? null }); return r.attachments ?? []; } })),
    // a starting point (ui.newThread.starter): {spec} with its ThreadSpec as data; each run recorded in runs (with its env)
    starter: (r) => keep(r.spec.id, ctx.ui.newThread.starter({ ...r.spec, spec: (env) => { runs.push({ id: r.spec.id, at: Date.now(), env: env ?? null }); return r.spec.spec; } })),
    'filter-off': (r) => handles.get(r.id)?.off(),
    update: (r) => handles.get(r.id)?.update(r.patch),
    dispose: (r) => { handles.get(r.id)?.dispose(); handles.delete(r.id); return true; },
    // any declaration: {kind, presentation?, spec} (kind a ui method: hide, decorate, replace, reorder, add, ...)
    rule: (r) => keep(r.spec.id, r.presentation !== undefined ? ctx.ui[r.kind](r.presentation, r.spec) : ctx.ui[r.kind](r.spec)),
    parts: (r) => ctx.ui.parts(r.presentation, r.slot ? { slot: r.slot } : undefined),
    // a status (ui.status), with a run that records its click when `run` is true
    status: (r) => keep(r.spec.id, ctx.ui.status({ ...r.spec, ...(r.run ? { run: (env) => { runs.push({ id: r.spec.id, at: Date.now(), subject: env?.subject ?? null, window: env?.window ?? null }); } } : {}) })),
    runs: () => runs,
    // a section of rows on one of the app's settings pages (ui.settings.section)
    'settings-section': (r) => keep(r.spec.id, ctx.ui.settings.section(r.spec)),
    // a theme on the app's Appearance page (ui.theme.add, H7y)
    theme: (r) => keep(r.spec.id, ctx.ui.theme.add(r.spec)),
    // a temporary change of some Settings (ctx.graph.override, H7y): {spec}; override-restore {id} gives the user's values back
    override: async (r) => { const h = ctx.graph.override(r.spec); handles.set(`override:${r.spec.id}`, h); return { id: h.id, applied: await h.applied }; },
    'override-restore': async (r) => { const out = await handles.get(`override:${r.id}`)?.restore(); handles.delete(`override:${r.id}`); return out ?? null; },
    // where a link goes (ui.links.route, §3.14): {spec, run?}; run: true records each link it opens itself to runs as {id: 'link', env}
    'link-route': (r) => keep(r.spec.id, ctx.ui.links.route({ ...r.spec, ...(r.run ? { run: (env) => { runs.push({ id: 'link', at: Date.now(), env }); } } : {}) })),
    // several changes, one approval (ctx.graph.invokeAll, §3.14): {calls, reason?}
    'invoke-all': (r) => ctx.graph.invokeAll(r.calls, { reason: r.reason }),
    // one operation: {ref, operation, args?, automatic?} (automatic: one of the mod's automatic actions, its switch on)
    act: (r) => ctx.graph.invoke(r.ref, r.operation, r.args ?? [], ...(r.automatic ? [{ automatic: r.automatic }] : [])),
    // an order of the sidebar's lists (ui.sidebar.order)
    'sidebar-order': (r) => keep(r.spec.id, ctx.ui.sidebar.order(r.spec)),
    // Request.ask (public-hooks.md §3.6): {} approves a read-only command as its automatic action `approve-reads`, denies one that names
    // qa-h6-deny, lets the rest through; each request it sees goes to runs as {id: 'ask', command, said}
    'ask-on': () => {
      handles.get('ask')?.dispose();
      handles.set('ask', ctx.graph.intercept('CommandApproval', 'ask', (call, next) => {
        const c = call.instance.state;
        const said = c.parsed?.readOnly ? 'approve' : String(c.command).includes('qa-h6-deny') ? 'deny' : 'next';
        runs.push({ id: 'ask', at: Date.now(), command: c.display ?? c.command, said });
        return said === 'approve' ? { approve: 'once', automatic: 'approve-reads' } : said === 'deny' ? { deny: 'qa.hooks denies it' } : next();
      }, { replaces: true }));
      return true;
    },
    'ask-off': () => { handles.get('ask')?.dispose(); handles.delete('ask'); return true; },
    // a policy (public-hooks.md §3.7): {spec} registers it (its id replaces one of the same id); policy-off {id} disposes it; policies {}
    policy: async (r) => { const h = ctx.graph.policy(r.spec); await h.accepted; handles.set(`policy:${r.spec.id}`, h); return true; },
    'policy-off': async (r) => { await handles.get(`policy:${r.id}`)?.dispose(); handles.delete(`policy:${r.id}`); return true; },
    policies: () => ctx.graph.policies(),
    assess: (r) => ctx.graph.assess(r.ref, r.operation, r.args ?? []),
    // after an operation (public-hooks.md §3.4): {type, operation, where?}; each record goes to runs as {id: 'after', record}
    'after-on': (r) => { handles.get('after')?.dispose(); handles.set('after', ctx.graph.after(r.type, r.operation, (rec) => { runs.push({ id: 'after', at: Date.now(), record: rec }); }, r.where ? { where: r.where } : undefined)); return true; },
    'after-off': () => { handles.get('after')?.dispose(); handles.delete('after'); return true; },
    // an interceptor that lets the call through after `delayMs` (H6h: a held action that goes): {type, operation, delayMs?}; intercept-off {}
    'intercept-pass': (r) => {
      handles.get('pass')?.dispose();
      handles.set('pass', ctx.graph.intercept(r.type, r.operation, async (call, next) => {
        await new Promise((res) => setTimeout(res, Number(r.delayMs) || 0));
        runs.push({ id: 'pass', at: Date.now(), operation: r.operation, origin: call.origin ?? null });
        return next();
      }));
      return true;
    },
    'intercept-off': () => { handles.get('pass')?.dispose(); handles.delete('pass'); return true; },
    // query and search (public-hooks.md §3.2): query {q}; search {text, opts?}; watch {query}: a view, each message to runs as
    // {id: 'watch', type, on, ref}; unwatch {}
    query: (r) => ctx.graph.query(r.q),
    search: (r) => ctx.graph.search(r.text, r.opts ?? {}),
    watch: (r) => {
      handles.get('watch')?.dispose();
      handles.set('watch', ctx.graph.subscribe(r.query, (m) => { runs.push({ id: 'watch', at: Date.now(), type: m.type, on: m.on ?? null, ref: m.event?.ref ?? null }); }));
      return true;
    },
    unwatch: () => { handles.get('watch')?.dispose(); handles.delete('watch'); return true; },
    // declarations with runs (§3.14), each run recorded in runs as {id, via, subject, args?}: command {spec}, slash {spec}, control {spec}
    command: (r) => keep(r.spec.id, ctx.ui.commands.add({ ...r.spec, run: (env) => { runs.push({ id: r.spec.id, at: Date.now(), via: env?.via ?? null, subject: env?.subject ?? null }); } })),
    slash: (r) => keep(r.spec.id, ctx.ui.composer.slash({ ...r.spec, run: (env) => { runs.push({ id: r.spec.id, at: Date.now(), via: 'slash', args: env?.args ?? null }); } })),
    control: (r) => keep(r.spec.id, ctx.ui.composer.control({ ...r.spec, run: (env) => { runs.push({ id: r.spec.id, at: Date.now(), via: 'control', subject: env?.subject ?? null }); } })),
    // a question with fields (§3.14): ask {spec, withdrawAfterMs?}: its result goes to runs as {id: 'ask', result}; open-in {spec}: its run to runs
    ask: (r) => {
      const ac = new AbortController();
      if (r.withdrawAfterMs) setTimeout(() => ac.abort(), r.withdrawAfterMs);
      ctx.ui.ask({ ...r.spec, signal: ac.signal }).then((result) => { runs.push({ id: 'ask', at: Date.now(), result }); });
      return true;
    },
    'open-in': (r) => keep(r.spec.id, ctx.ui.openIn.add({ ...r.spec, run: (env) => { runs.push({ id: r.spec.id, at: Date.now(), via: 'openIn', subject: env?.subject ?? null }); } })),
    // a notification (§3.14): notify {key, spec} (its actions {id, title} record their runs as {id: 'notify', action, subject}); notify-off {key}
    notify: async (r) => {
      await handles.get(`notify:${r.key}`)?.dismiss();
      const h = ctx.ui.notify({ ...r.spec, actions: (r.spec.actions ?? []).map((x) => ({ ...x, run: (env) => { runs.push({ id: 'notify', at: Date.now(), action: env.action, subject: env.subject }); } })) });
      handles.set(`notify:${r.key}`, { dispose: () => h.dismiss(), dismiss: () => h.dismiss() });
      return h.shown;
    },
    'notify-off': async (r) => { await handles.get(`notify:${r.key}`)?.dismiss(); handles.delete(`notify:${r.key}`); return true; },
    // the Dock (§3.14): dock-badge {spec} (its id replaces one of the same id); dock-off {id}; dock-attention {kind?}
    'dock-badge': async (r) => { await handles.get(`dock:${r.spec.id}`)?.dispose(); handles.set(`dock:${r.spec.id}`, ctx.ui.dock.badge(r.spec)); return true; },
    'dock-off': async (r) => { await handles.get(`dock:${r.id}`)?.dispose(); handles.delete(`dock:${r.id}`); return true; },
    'dock-attention': (r) => ctx.ui.dock.attention(r.kind),
    // what a new chat starts with (public-hooks.md §3.8): defaults {spec}; defaults-off {id}
    defaults: async (r) => { const h = ctx.graph.defaults(r.spec); await h.accepted; handles.set(`defaults:${r.spec.id}`, h); return true; },
    'defaults-off': async (r) => { await handles.get(`defaults:${r.id}`)?.dispose(); handles.delete(`defaults:${r.id}`); return true; },
    // a send of this mod's, with its own settings: {ref, text, options?} (Thread.send asks the user first, R17)
    send: (r) => ctx.graph.invoke(r.ref, 'send', [{ parts: [{ kind: 'text', text: r.text }] }, ...(r.options ? [r.options] : [])], ...(r.automatic ? [{ automatic: r.automatic }] : [])),
    // what the pickers offer (ui.choices): {of, spec, add?: true} (add: one entry that records its runs)
    choices: (r) => keep(r.spec.id, ctx.ui.choices(r.of, { ...r.spec, ...(r.add ? { add: [{ id: 'qa', title: 'QA entry', description: 'added by qa.hooks', run: (env) => { runs.push({ id: r.spec.id, at: Date.now(), env: env ?? null }); } }] } : {}) })),
    // a section of the sidebar (ui.sidebar.section); `action: true` gives it one action that records its clicks
    'sidebar-section': (r) => keep(r.spec.id, ctx.ui.sidebar.section({ ...r.spec, ...(r.action ? { actions: [{ id: 'qa', title: 'QA', run: (env) => { runs.push({ id: r.spec.id, at: Date.now(), env: env ?? null }); } }] } : {}) })),
  };
  const timer = setInterval(async () => {
    for (const name of Object.keys(ops)) {
      let body;
      try { body = await fs.readFile(path.join(files, name), 'utf8'); await fs.rm(path.join(files, name)); } catch { continue; }
      let out;
      try { out = { ok: true, value: (await ops[name](JSON.parse(body || '{}'))) ?? null }; } catch (e) { out = { ok: false, error: String(e?.message ?? e), code: e?.code ?? null }; }
      await fs.writeFile(path.join(files, `${name}.out.json`), `${JSON.stringify(out, null, 2)}\n`);
    }
  }, 500);
  return () => { clearInterval(timer); for (const h of handles.values()) { try { h.dispose(); } catch { /* gone */ } } };
}

export default { host };
