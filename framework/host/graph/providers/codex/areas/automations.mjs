// Local automations and the chats their runs started (breadth step D9). Definitions and writes belong to the app, not the protocol.
import { refs, userContent } from '../map.mjs';
import { automationValues } from '../../../defaults.mjs';

export const realizes = {
  types: ['Automation'],
  operations: { Automation: ['runNow', 'enable', 'disable', 'edit', 'delete', 'open'], Agent: ['newAutomation'], Project: ['newAutomation'], Thread: ['automate'] },
  supports: { Automation: ['lastRunAt', 'nextRunAt', 'where', 'notifications', 'archiveRuns', 'open'], Agent: ['newAutomation'], Project: ['newAutomation'], Thread: ['automate'] },
  events: { Automation: ['started', 'ran', 'failed', 'changed'] },
  links: { Automation: ['agent', 'project', 'watches'], CodexThread: ['automation'], CodexTurn: ['automation'], App: ['automations'] },
};

/** Keep the RRULE verbatim: edit writes it back through the app's service. DTSTART is not part of the schedule's rule. */
export function scheduleOf(rrule) {
  const line = rrule.split(/\r?\n/).find((s) => s && !/^DTSTART/i.test(s)) ?? '';
  const parts = Object.fromEntries(line.replace(/^RRULE:/i, '').split(';').map((s) => s.split('=')));
  if (parts.COUNT === '1') return { kind: 'once', rrule };
  if (parts.FREQ === 'MINUTELY' || parts.FREQ === 'HOURLY') return { kind: 'interval', every: Number(parts.INTERVAL ?? 1) * (parts.FREQ === 'HOURLY' ? 60 : 1), rrule };
  if (parts.FREQ === 'DAILY' || parts.FREQ === 'WEEKLY') return {
    kind: 'calendar', days: parts.BYDAY ? parts.BYDAY.toLowerCase().split(',') : [],
    hours: parts.BYHOUR ? parts.BYHOUR.split(',').map(Number) : [], minutes: parts.BYMINUTE ? parts.BYMINUTE.split(',').map(Number) : [], rrule,
  };
  return { kind: 'calendar', rrule };
}

const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const ints = (v, min, max) => Array.isArray(v) && v.length > 0 && v.every((n) => Number.isSafeInteger(n) && n >= min && n <= max);
/** An Automation.schedule as the app's RRULE (the inverse of scheduleOf), or null when it is not one. */
export function rruleOf(schedule) {
  if (!schedule || typeof schedule !== 'object') return null;
  if (typeof schedule.rrule === 'string' && schedule.rrule.trim() && schedule.kind !== 'interval' && schedule.kind !== 'calendar') return schedule.rrule.trim();
  if (schedule.kind === 'interval') {
    const n = schedule.every;
    if (!Number.isSafeInteger(n) || n < 1 || n > 60 * 24 * 31) return null;
    return n % 60 === 0 ? `FREQ=HOURLY;INTERVAL=${n / 60};BYMINUTE=0` : `FREQ=MINUTELY;INTERVAL=${n}`;
  }
  if (schedule.kind === 'calendar') {
    if (!ints(schedule.hours, 0, 23) || !ints(schedule.minutes, 0, 59)) return null;
    const at = `BYHOUR=${schedule.hours.join(',')};BYMINUTE=${schedule.minutes.join(',')}`;
    if (schedule.monthDay !== undefined) return Number.isSafeInteger(schedule.monthDay) && schedule.monthDay >= 1 && schedule.monthDay <= 31 ? `FREQ=MONTHLY;BYMONTHDAY=${schedule.monthDay};${at}` : null;
    const days = schedule.days === undefined || (Array.isArray(schedule.days) && !schedule.days.length) ? DAYS : Array.isArray(schedule.days) ? schedule.days.map((d) => String(d).toUpperCase()) : null;
    return days && days.every((d) => DAYS.includes(d)) ? `FREQ=WEEKLY;BYDAY=${days.join(',')};${at}` : null;
  }
  return null;
}

export function automationData(item) {
  return {
    ref: refs.automation(item.id),
    state: {
      name: item.name, prompt: userContent([{ type: 'text', text: item.prompt ?? '' }]), schedule: scheduleOf(item.rrule ?? ''), enabled: item.status === 'ACTIVE',
      ...(typeof item.lastRunAt === 'number' ? { lastRunAt: item.lastRunAt } : {}),
      ...(typeof item.nextRunAt === 'number' ? { nextRunAt: item.nextRunAt } : {}),
      ...(item.kind !== 'heartbeat' ? { where: item.executionEnvironment === 'worktree' ? 'worktree' : 'local', archiveRuns: item.autoArchive === true } : {}),
      notifications: item.notificationPolicy === 'failed_runs_only' ? 'failures' : 'all',
    },
    links: { agent: refs.agent(), project: item.projectId ? refs.project(item.projectId) : null, watches: item.targetThreadId ? refs.thread(item.targetThreadId) : null },
  };
}

export function types(feed) {
  return { Automation: { operations: {
    runNow: { effect: 'external', approval: ({ instance }) => feed().prompt('runNow', instance), handler: ({ ref }) => feed().runNow(ref) },
    enable: { effect: 'external', approval: ({ instance }) => feed().prompt('enable', instance), handler: ({ ref }) => feed().enable(ref) },
    disable: { effect: 'external', approval: ({ instance }) => feed().prompt('disable', instance), handler: ({ ref }) => feed().disable(ref) },
    edit: { effect: 'external', approval: ({ instance, args }) => feed().prompt('edit', instance, args[0]), handler: ({ ref, args }) => feed().edit(ref, args[0]) },
    delete: { effect: 'external', approval: ({ instance }) => feed().prompt('delete', instance), handler: ({ ref }) => feed().delete(ref) },
    open: { effect: 'local', handler: ({ ref, args }) => feed().open(ref, args[0]) },
  } },
  // Creating one (E7 usefulness rework): on the owner of the new automation, as the user sets one up in the app. The mods' defaults are
  // filled into the spec once (`resolve`), before the interceptors, the policies and the user's approval: all of them, and the create, have
  // the same spec.
  Agent: { operations: { newAutomation: { effect: 'external', resolve: ({ args }) => feed().resolve(args), approval: ({ args }) => feed().createPrompt(args[0]), handler: ({ args }) => feed().create(args[0]) } } },
  Project: { operations: { newAutomation: { effect: 'external', resolve: ({ ref, args }) => feed().resolve(args, { project: ref }), approval: ({ ref, args }) => feed().createPrompt({ ...args[0], project: ref }), handler: ({ ref, args }) => feed().create({ ...args[0], project: ref }) } } },
  Thread: { operations: { automate: { effect: 'external', resolve: ({ ref, args }) => feed().resolve(args, { watches: ref }), approval: ({ ref, args }) => feed().createPrompt({ ...args[0], watches: ref }), handler: ({ ref, args }) => feed().create({ ...args[0], watches: ref }) } } },
  };
}

export function createFeed(ctx) {
  const now = ctx.now ?? Date.now;
  let known = new Map(), watched = new Set(), migrated = false, heard = false;
  const runs = new Map(), seenRuns = new Set(), heartbeatTurns = new Map(), waiting = new Set();
  let reading = null, again = false, finishedAt = -Infinity, timer = null, soon = null, relink = null, disposed = false;
  const refused = (reason, message) => ({ status: 'refused', reason, message });
  const textOf = (content) => content?.parts?.filter((p) => p?.kind === 'text').map((p) => p.text).join('') ?? '';

  function heartbeat(threadId, turn) {
    if (!watched.has(threadId)) return null;
    const first = turn?.items?.find((item) => item.type === 'userMessage');
    const input = first ? userContent(first.content) : ctx.graph.referrers(refs.turn(turn.id), 'turn')
      .filter((x) => x.ref.type === 'UserMessage' && !x.gone).sort((a, b) => a.state.createdAt - b.state.createdAt)[0]?.state.content;
    const text = textOf(input);
    const id = text.startsWith('<heartbeat>') ? /<automation_id>([^<]+)<\/automation_id>/.exec(text)?.[1] : null;
    if (known.has(id)) heartbeatTurns.set(turn.id, id);
    const saved = heartbeatTurns.get(turn.id);
    return known.has(saved) ? saved : null;
  }

  // a run's turns whose events went, each once and in order (started, then ran or failed)
  const startedTurns = new Set(), endedTurns = new Set();
  /**
   * The automation a turn is a run of: a run chat's first turn (its link, set from the app's run records), or a turn the app's scheduler
   * sent into the chat a heartbeat watches (its trigger, from the app's own turn/start, and the automation its first message names: a
   * message's text alone is anyone's to write); none otherwise (a later turn the user starts in a run's chat is not the run).
   */
  function runOf(threadId, turnId) {
    const turn = ctx.resident(refs.turn(turnId));
    if (!turn) return null;
    const linked = turn.links.automation?.id;
    if (linked && known.get(linked)?.item.kind === 'cron' && runs.get(threadId) === linked) return linked;
    if (turn.state.trigger !== 'automation' || !String(turn.state.triggerDetail ?? '').startsWith('automation_heartbeat')) return null;
    const id = heartbeat(threadId, { id: turnId });
    const item = known.get(id)?.item;
    return item?.kind === 'heartbeat' && item.targetThreadId === threadId ? id : null;
  }
  /** What a run's turn did that its automation has not said yet: a heartbeat's start (a cron run's starts with its chat), its end. */
  function lifecycle(threadId, turnId) {
    const id = runOf(threadId, turnId);
    if (!id) return;
    const at = { thread: refs.thread(threadId), turn: refs.turn(turnId) };
    if (known.get(id).item.kind === 'heartbeat' && !startedTurns.has(turnId)) { startedTurns.add(turnId); trim(startedTurns); started(id, at, known.get(id).data.state); }
    const status = ctx.resident(refs.turn(turnId))?.state.status;
    if ((status === 'completed' || status === 'failed') && !endedTurns.has(turnId)) {
      endedTurns.add(turnId); trim(endedTurns);
      ctx.emitEvent(refs.automation(id), status === 'completed' ? 'ran' : 'failed', at);
    }
  }
  const trim = (set) => { while (set.size > 2000) set.delete(set.values().next().value); };
  // a turn's trigger can be known after its notifications (the answer to its turn/start came later): its lifecycle is looked at again then
  const triggers = ctx.graph.onEvent?.((e) => {
    if (disposed || e.kind !== 'changed' || ctx.graph.type(e.ref?.type)?.concept !== 'Turn' || e.ref.provider !== refs.agent().provider) return;
    if (Array.isArray(e.fields) && !e.fields.includes('trigger')) return;
    const turn = ctx.resident(e.ref);
    if (turn?.state.trigger === 'automation' && turn.links.thread?.id && !endedTurns.has(e.ref.id)) lifecycle(turn.links.thread.id, e.ref.id);
  }) ?? null;
  /** A run started: its chat (and turn), and when it was due when that was before now (a run asked for, Run now, was not due). */
  function started(id, at, state) {
    const due = state?.nextRunAt;
    ctx.emitEvent(refs.automation(id), 'started', { ...at, ...(Number.isFinite(due) && due <= ctx.now() ? { scheduledAt: due } : {}) });
  }

  function link(instance, name, automation) {
    if ((instance.links[name]?.id ?? null) === (automation?.id ?? null) && (instance.links[name]?.provider ?? null) === (automation?.provider ?? null)) return;
    ctx.safe('automation link', () => ctx.handle.update(instance.ref, { links: { [name]: automation } }));
  }

  /** A chat's first turn (by its start), or null. */
  const firstTurn = (threadId) => ctx.graph.referrers(refs.thread(threadId), 'thread').filter((x) => ctx.graph.type(x.ref.type)?.concept === 'Turn' && !x.gone)
    .sort((a, b) => a.state.startedAt - b.state.startedAt)[0]?.ref.id ?? null;

  function applyLinks() {
    if (disposed) return;
    for (const thread of ctx.graph.list('CodexThread')) {
      if (thread.gone || thread.ref.provider !== refs.agent().provider) continue;
      const id = runs.get(thread.ref.id), run = known.get(id);
      const automation = run ? refs.automation(id) : null;
      link(thread, 'automation', automation);
      const turns = ctx.graph.referrers(thread.ref, 'thread').filter((x) => ctx.graph.type(x.ref.type)?.concept === 'Turn' && !x.gone)
        .sort((a, b) => a.state.startedAt - b.state.startedAt);
      for (const turn of turns) {
        const heartbeatId = heartbeat(thread.ref.id, { id: turn.ref.id });
        link(turn, 'automation', heartbeatId ? refs.automation(heartbeatId) : run?.item.kind === 'cron' && turn === turns[0] ? automation : null);
      }
    }
  }

  /** Overlapping callers share this promise, with one more read after the running read. Failed reads leave the graph alone. */
  function read() {
    if (disposed) return Promise.resolve();
    if (reading) { again = true; return reading; }
    reading = (async () => {
      do {
        again = false;
        try {
          const r = await ctx.mainOp('list', {});
          if (!r.ok) throw new Error(r.error);
          if (disposed) return;
          const next = new Map(r.result.automations.map((item) => [item.id, { item, data: automationData(item) }]));
          for (const [id, { data }] of next) {
            const before = known.get(id)?.data;
            ctx.safe('automation', () => ctx.handle.put(data.ref, { state: data.state, links: data.links }));
            if (heard && before && JSON.stringify(before.state) !== JSON.stringify(data.state)) ctx.emitEvent(data.ref, 'changed');
          }
          for (const [id, { data }] of known) if (!next.has(id)) ctx.safe('automation removal', () => ctx.handle.remove(data.ref));
          const prev = known;
          known = next;
          migrated = r.result.migrated === true;
          watched = new Set([...known.values()].filter(({ item }) => item.kind === 'heartbeat').map(({ item }) => item.targetThreadId).filter(Boolean));
          for (const id of watched) runs.delete(id);
          const automations = [...known.values()].map(({ data }) => data.ref);
          const app = ctx.resident(refs.app());
          if (app && JSON.stringify(app.links.automations) !== JSON.stringify(automations)) ctx.safe('app automations', () => ctx.handle.update(app.ref, { links: { automations } }));
          const fresh = [];
          for (const row of r.result.runs) {
            if (!row.threadId || watched.has(row.threadId)) continue;
            runs.set(row.threadId, row.automationId);
            // a new run in its own chat: started (when it was due, as read before it ran)
            if (heard && !seenRuns.has(row.threadId) && known.has(row.automationId)) { started(row.automationId, { thread: refs.thread(row.threadId) }, prev.get(row.automationId)?.data.state); fresh.push(row.threadId); }
            seenRuns.add(row.threadId);
          }
          applyLinks();
          // a cron run whose first turn ended before its record was read: its end, after its start
          for (const threadId of fresh) { const first = firstTurn(threadId); if (first) lifecycle(threadId, first); }
          heard = true;
        } catch (e) { ctx.log.warn('automations: the automations could not be read', { message: String(e?.message ?? e) }); }
        finally { finishedAt = now(); }
      } while (again && !disposed);
    })().finally(() => { reading = null; });
    return reading;
  }

  function unavailable(op, ref) {
    if (!known.has(ref.id)) return refused('unavailable', 'the automation is gone');
    if (op === 'runNow') {
      if (!ctx.serverUp()) return ctx.DOWN;
      if (known.get(ref.id).item.kind === 'heartbeat') return refused('unsupported', "a heartbeat runs in the thread it watches, with that chat's mode: run it from the app");
    } else if (migrated) return refused('unavailable', "this account's automations are kept online by the app: change them in its Automations page");
    return null;
  }

  function edits(item, fields) {
    const changes = {};
    if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).some((k) => !['name', 'prompt', 'schedule'].includes(k))) return refused('invalid', 'edit takes name, prompt, or a schedule with an rrule');
    if (Object.hasOwn(fields, 'name')) {
      if (typeof fields.name !== 'string' || !fields.name.trim()) return refused('invalid', 'a non-empty name is needed');
      if (fields.name !== item.name) changes.name = fields.name;
    }
    if (Object.hasOwn(fields, 'prompt')) {
      if (typeof fields.prompt !== 'string' && (!fields.prompt || !Array.isArray(fields.prompt.parts) || fields.prompt.parts.some((p) => p?.kind === 'text' && typeof p.text !== 'string'))) return refused('invalid', 'prompt must be text or Content');
      const prompt = typeof fields.prompt === 'string' ? fields.prompt : textOf(fields.prompt);
      if (prompt !== (item.prompt ?? '')) changes.prompt = prompt;
    }
    if (Object.hasOwn(fields, 'schedule')) {
      if (!fields.schedule || typeof fields.schedule !== 'object' || Array.isArray(fields.schedule) || typeof fields.schedule.rrule !== 'string') return refused('invalid', 'schedule needs an rrule string');
      if (fields.schedule.rrule !== (item.rrule ?? '')) changes.rrule = fields.schedule.rrule;
    }
    return changes;
  }

  async function appOp(op, args) {
    const r = await ctx.mainOp(op, args);
    if (r.ok) return null;
    if (r.refused) return refused('unavailable', r.error);
    throw new Error(r.error);
  }

  async function update(ref, op, fields) {
    const no = unavailable(op, ref);
    if (no) return no;
    const item = known.get(ref.id).item;
    const changes = op === 'edit' ? edits(item, fields) : item.status === (op === 'enable' ? 'ACTIVE' : 'PAUSED') ? {} : { status: op === 'enable' ? 'ACTIVE' : 'PAUSED' };
    if (changes.status === 'refused') return changes;
    if (!Object.keys(changes).length) return null;
    const result = await appOp('update', { id: ref.id, changes });
    if (result) return result;
    await read();
    return null;
  }

  /**
   * A spec with the mods' defaults of what it leaves out (public-hooks.md §3.8, H6i): in the mods' order, each where read on the
   * automation to be (its spec as its fields, `project` and `watches` its links too). One that watches a chat takes none of a chat run's
   * fields.
   */
  function withDefaults(spec) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec) || typeof ctx.graph?.defaultsFor !== 'function') return spec;
    const { project, watches } = spec;
    const toBe = { ref: { type: 'Automation', provider: refs.agent().provider, id: '(new)' }, state: { ...spec }, links: { ...(project ? { project } : {}), ...(watches ? { watches } : {}) } };
    return { ...spec, ...automationValues(ctx.graph.defaultsFor('Automation', toBe), spec, Boolean(watches)) };
  }
  /** A spec (AutomationSpec) as the item the app's service creates, or the refusal. */
  function itemFor(spec) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return refused('invalid', 'an automation spec is needed');
    const prompt = typeof spec.prompt === 'string' ? spec.prompt : textOf(spec.prompt);
    if (!prompt.trim()) return refused('invalid', 'a prompt is needed');
    const rrule = rruleOf(spec.schedule);
    if (!rrule) return refused('invalid', 'the schedule is {kind: "interval", every: minutes}, {kind: "calendar", days?, hours, minutes}, {kind: "calendar", monthDay, hours, minutes} or {rrule}');
    const name = typeof spec.name === 'string' && spec.name.trim() ? spec.name.trim().slice(0, 250) : prompt.trim().replace(/\s+/g, ' ').slice(0, 80);
    const status = spec.enabled === false ? 'PAUSED' : 'ACTIVE';
    const policy = spec.notifications === 'failures' ? { notificationPolicy: 'failed_runs_only' } : {};
    const codex = refs.agent().provider;
    if (spec.watches) {
      if (spec.project || spec.settings || spec.where || spec.archiveRuns !== undefined) return refused('invalid', 'an automation that watches a chat runs with that chat\'s project and settings: it takes no project, settings, where or archiveRuns');
      if (spec.watches.provider !== codex || typeof spec.watches.id !== 'string') return refused('unsupported', 'an automation watches one of Codex\'s chats');
      return { kind: 'heartbeat', name, prompt, status, targetThreadId: spec.watches.id, ...policy, rrule };
    }
    if (spec.project && (spec.project.provider !== codex || typeof spec.project.id !== 'string')) return refused('unsupported', 'an automation runs in one of Codex\'s projects');
    const settings = spec.settings && typeof spec.settings === 'object' ? spec.settings : {};
    const model = typeof settings.model === 'string' ? settings.model : settings.model && typeof settings.model.id === 'string' ? settings.model.id : null;
    const effort = typeof settings.effort === 'string' ? settings.effort : null;
    if (spec.where === 'worktree' && !spec.project) return refused('invalid', 'a worktree needs a project');
    return { kind: 'cron', name, prompt, status, projectId: spec.project ? spec.project.id : null, executionEnvironment: spec.where === 'worktree' ? 'worktree' : 'local',
      model, reasoningEffort: effort, autoArchive: spec.archiveRuns === true, ...policy, rrule };
  }

  return {
    read,
    /**
     * A new automation's spec with the mods' defaults (its operation's `resolve`, once per call); `fixed`: what the operation's owner
     * gives it (its project, the chat it watches), read by the defaults' wheres and not added to the spec.
     */
    resolve(args, fixed = {}) {
      const spec = args[0];
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return args;
      const full = withDefaults({ ...spec, ...fixed });
      for (const k of Object.keys(fixed)) if (!(k in spec)) delete full[k];
      return [full, ...args.slice(1)];
    },
    /** A new automation (Agent.newAutomation, Project.newAutomation, Thread.automate), its spec resolved: the app's own create, then its ref. */
    async create(spec) {
      if (migrated) return refused('unavailable', "this account's automations are kept online by the app: create them in its Automations page");
      const item = itemFor(spec);
      if (item.status === 'refused') return item;
      const r = await ctx.mainOp('create', { item });
      if (!r.ok) { if (r.refused) return refused('unavailable', r.error); throw new Error(r.error); }
      await read();
      return refs.automation(r.result.id);
    },
    createPrompt(spec) {
      const item = itemFor(spec);
      if (item.status === 'refused' || migrated) return null;
      const when = item.status === 'PAUSED' ? 'It starts turned off' : 'It runs on its schedule from now on';
      const where = item.kind === 'heartbeat' ? ', each run a turn in the chat it watches' : item.executionEnvironment === 'worktree' ? ', each run a new chat in a worktree of its project' : ', each run a new chat';
      return { action: `create the automation “${item.name}”`, detail: `${when}${item.status === 'PAUSED' ? '' : where}; each run counts toward your usage.` };
    },
    /** Show it where the user manages it (its page; a heartbeat, the chat it watches). */
    async open(ref, opts) {
      const entry = known.get(ref.id);
      if (!entry) return refused('unavailable', 'the automation is gone');
      // `{window}`: in that window (Window.open's), else the focused one
      const w = opts && typeof opts === 'object' ? opts.window : undefined;
      const windowId = w && w.type === 'Window' && w.provider === 'codexmods.windows' && /^\d{1,12}$/.test(String(w.id)) ? Number(w.id) : null;
      if (w !== undefined && w !== null && windowId === null) return refused('invalid', 'window is a Window');
      const r = await ctx.mainOp('open', { id: ref.id, ...(entry.item.kind === 'heartbeat' ? { threadId: entry.item.targetThreadId } : {}), ...(windowId !== null ? { windowId } : {}) });
      if (!r.ok) return r.refused ? refused('unavailable', r.error) : refused('unavailable', r.error ?? 'it could not be shown');
      return null;
    },
    start() {
      if (!timer && !disposed) { timer = setInterval(read, 60_000); timer.unref?.(); }
      return read();
    },
    serverUp: read,
    // an automation it does not have (made a moment ago) is read at once, however fresh the last read (after one under way, which may have
    // begun before it was made): the user's action on it is decided then
    observe(ref, concept) {
      if (concept !== 'Automation') return undefined;
      if (ref && !known.has(ref.id)) return Promise.resolve(reading).then(() => (known.has(ref.id) ? undefined : read()));
      return reading ?? (now() - finishedAt > 30_000 ? read() : Promise.resolve());
    },
    responded(method, result) {
      if (disposed || !['thread/start', 'thread/resume', 'thread/fork', 'thread/read', 'thread/list', 'thread/turns/list'].includes(method)) return;
      if (method === 'thread/turns/list') {
        for (const turn of result?.data ?? []) {
          const threadId = ctx.resident(refs.turn(turn.id))?.links.thread?.id;
          if (threadId) heartbeat(threadId, turn);
        }
      } else if (result?.thread) for (const turn of result.thread.turns ?? []) heartbeat(result.thread.id, turn);
      applyLinks();
      // The core's own turns/list continuation also puts turns after the response observer.
      clearTimeout(relink);
      relink = setTimeout(() => { relink = null; applyLinks(); }, 0);
      relink.unref?.();
    },
    notified(method, p) {
      if (disposed) return;
      if (method === 'thread/started' && p?.thread?.threadSource === 'automation') {
        for (const w of waiting) w.resolve(refs.thread(p.thread.id));
        clearTimeout(soon);
        soon = setTimeout(() => { soon = null; read(); }, 500);
        soon.unref?.();
      }
      if (method === 'turn/started' || method === 'turn/completed') {
        heartbeat(p.threadId, p.turn);
        applyLinks();
        lifecycle(p.threadId, p.turn.id);
      }
      // a heartbeat's turn says what it is in its first message, which comes after the turn starts
      if ((method === 'item/started' || method === 'item/completed') && p.item?.type === 'userMessage' && typeof p.turnId === 'string') {
        applyLinks();
        lifecycle(p.threadId, p.turnId);
      }
    },
    prompt(op, instance, fields) {
      if (unavailable(op, instance.ref)) return null;
      const item = known.get(instance.ref.id).item;
      if (op === 'enable' || op === 'disable') {
        if ((item.status === 'ACTIVE') === (op === 'enable')) return null;
      } else if (op === 'edit') {
        const changes = edits(item, fields);
        if (changes.status === 'refused' || !Object.keys(changes).length) return null;
      }
      const name = `the automation “${item.name}”`;
      if (op === 'runNow') return { action: `run ${name} now`, detail: 'It starts a chat with its prompt, which counts toward your usage.' };
      if (op === 'delete') return { action: `delete ${name}`, detail: 'Its definition and its memory are deleted; its chats stay.' };
      return { action: `${op === 'enable' ? 'turn on' : op === 'disable' ? 'turn off' : 'change'} ${name}`, detail: 'It changes when or how it runs from now on.' };
    },
    enable: (ref) => update(ref, 'enable'),
    disable: (ref) => update(ref, 'disable'),
    edit: (ref, fields) => update(ref, 'edit', fields),
    async delete(ref) {
      const no = unavailable('delete', ref);
      if (no) return no;
      const result = await appOp('delete', { id: ref.id });
      if (result) return result;
      await read();
      return null;
    },
    async runNow(ref) {
      const no = unavailable('runNow', ref);
      if (no) return no;
      let timeout;
      const waiter = {};
      const started = new Promise((resolve) => { waiter.resolve = resolve; });
      waiting.add(waiter);
      try {
        const result = await appOp('run-now', { id: ref.id });
        if (result) return result;
        timeout = setTimeout(() => waiter.resolve(null), 15_000);
        timeout.unref?.();
        const thread = await started;
        await read();
        return thread;
      } finally { clearTimeout(timeout); waiting.delete(waiter); }
    },
    dispose() {
      disposed = true;
      triggers?.dispose?.();
      clearInterval(timer); clearTimeout(soon); clearTimeout(relink);
      for (const w of waiting) w.resolve(null);
      waiting.clear();
    },
  };
}
