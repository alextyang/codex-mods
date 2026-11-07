// The graph's authority policy (docs/design/breadth.md D0.2; boundary review R, finding 5a). One rule for reading, acting and intercepting,
// used by the runtime's `authorize` (acting) and by the mod ingress (reading and intercepting):
// - the user, the native provider and the framework may do what their ingress allows (it authenticates them);
// - a mod with `graph` registers types and provides instances; it reads and acts on its own instances (refs carrying its id), reads the
//   instances of types it declared (a type it registered, or a subtype of one), and intercepts operations of types it declared;
// - anything else needs a scoped grant: `graph.read` (reads), `graph.act` (operations), `graph.intercept` (interceptors), `graph.attach`
//   (a mod's own data on others' instances, docs/design/public-hooks.md §3.3), `graph.contribute` (its own instances linked to others':
//   a contribution to that instance's relations, graph-integrity G3.2; the link also needs `graph.read` covering the target's type),
//   bare for every type or with a list of type ids (a concept
//   covers its subtypes), where `act` and `intercept` may name `<Type>.<operation>`; a mod attaches to its own instances and those of
//   types it declared without one; an operation that answers sensitive content (its type says `content`: terminal output, a file's
//   contents, a diff; docs/graph/04 §6) is acted on, and intercepted (an interceptor and an `after` see its answer), only by a mod
//   with an act grant that names it (`graph.act:Terminal.tail`), never through a bare or type-wide one;
// - the framework's own instances (docs/design/systems.md S4: types the framework owns, docs/graph/07) are the user's: no mod acts on them,
//   intercepts or replaces their operations, whatever it was granted, the copy's update included (docs/design/graph-boundary.md B5). A mod
//   reads its own Mod; reading the rest needs `graph.read`.
// A provider id that is not a mod's (the native provider's, the framework's) is never a mod's own, whatever the mod is called.
// - the mods' settings (docs/design/systems.md E3: Settings and SettingsSections the framework's provider serves) are decided before any
//   grant: a mod reads and acts on its own (`set`, `reset`; the mod decoded exactly from the instance's id), reads another mod's only with
//   `graph.read` covering the type, never acts on another's, and no mod intercepts or replaces their operations. Settings other providers
//   serve keep the rules above.
// - E6 (docs/design/systems.md "E6 in detail", decision 6): a presentation whose subject the framework serves is the framework's too: a mod
//   reads it with `graph.read`, never acts on it or intercepts its operations. And on the framework's own calls (its UI acts as the user)
//   no mod's interceptor runs: no mod stops the framework's navigation to its own pages, or the copy's update (docs/design/graph-boundary.md
//   B5: the framework's own product is the user's, so a mod cannot stop the update that fixes or removes it).
// Node built-ins only (none needed).
import { parseInstanceId } from '../packages/settings.mjs';
import { namespaceOf, PREFIX as TOOL_PREFIX } from '../agent/namespace.mjs';

const SCOPES = ['graph.read', 'graph.act', 'graph.intercept', 'graph.attach', 'graph.contribute'];
/** Provider ids that belong to no mod: a mod's own instances are those whose provider id is its id, so these ids are never a mod's. */
export const RESERVED_PROVIDERS = Object.freeze(new Set(['codex', 'codexmods.framework', 'codexmods.windows', 'codexmods.commands']));
const FRAMEWORK_PROVIDER = 'codexmods.framework';

/** The mod id of a caller or interceptor owner (`mod:<id>` or `<id>`), or null for anything that is not a mod. */
export function modIdOf(caller) {
  if (!caller || caller.kind !== 'mod' || typeof caller.id !== 'string') return null;
  return caller.id.startsWith('mod:') ? caller.id.slice(4) : caller.id;
}

/**
 * May a mod with these grants add presentation rules to `presentation` (docs/design/systems.md S6)? `graph.present`, bare for every
 * presentation type or with a list of them (`graph.present:SidebarItem,MessageBlock`).
 */
export function presentAllowed(grants = [], presentation) {
  for (const g of grants) {
    if (g === 'graph.present') return true;
    if (g.startsWith('graph.present:') && g.slice('graph.present:'.length).split(',').map((x) => x.trim()).includes(presentation)) return true;
  }
  return false;
}

/**
 * `grants` -> { read, act, intercept, attach, contribute, listed }: each '*' (bare grant) or an array of entries (`Type` or `Type.operation`);
 * `listed` has each scope's entries as the grants list them, whatever else (a content operation needs one naming it, a bare grant or not).
 */
export function graphGrants(grants = []) {
  const out = Object.fromEntries(SCOPES.map((s) => [s, []]));
  const listed = Object.fromEntries(SCOPES.map((s) => [s, []]));
  for (const g of grants) {
    for (const scope of SCOPES) {
      if (g === scope) out[scope] = '*';
      else if (g.startsWith(`${scope}:`)) {
        const entries = g.slice(scope.length + 1).split(',').map((s) => s.trim()).filter(Boolean);
        listed[scope].push(...entries);
        if (out[scope] !== '*') out[scope].push(...entries);
      }
    }
  }
  return { read: out['graph.read'], act: out['graph.act'], intercept: out['graph.intercept'], attach: out['graph.attach'], contribute: out['graph.contribute'],
    listed: { read: listed['graph.read'], act: listed['graph.act'], intercept: listed['graph.intercept'], attach: listed['graph.attach'], contribute: listed['graph.contribute'] } };
}

/** Does `entries` cover the type (its chain: the type and its ancestors) and, when given, the operation? `named`: only an entry naming it. */
function covers(entries, chain, operation, named = false) {
  if (entries === '*') return !named;
  for (const e of entries) {
    const dot = e.indexOf('.');
    const type = dot < 0 ? e : e.slice(0, dot);
    const op = dot < 0 ? null : e.slice(dot + 1);
    if (!chain.includes(type)) continue;
    if (named ? op === operation : op === null || op === '*' || (operation !== undefined && op === operation)) return true;
  }
  return false;
}

/**
 * @param {{ grantsOf: (modId: string) => string[] | null | undefined, typeOf: (typeId: string) => { chain: string[], owner: string } | null | undefined,
 *   subjectOf?: (ref: object) => object | null | undefined }} deps
 *   `typeOf` is the registry's entry: `chain` is the type with its ancestors, the concept first; `owner` is 'native' or `mod:<id>`;
 *   `subjectOf` a presentation instance's subject ref (its `subject` link), when the graph holds it
 */
export function createPolicy({ grantsOf, typeOf, subjectOf, canonicalOf }) {
  /** What an instance is (its stored type), never the type a caller names for it (review 2026-11-05 #2): null when it is not known here. */
  const storedType = (ref) => {
    if (!ref || typeof canonicalOf !== 'function') return null;
    try { const t = canonicalOf(ref); return typeof t === 'string' && t ? t : null; } catch { return null; }
  };
  const chain = (typeId) => { const c = typeOf(typeId)?.chain; return Array.isArray(c) && c.length ? c : [typeId]; };
  const declared = (modId, typeId) => chain(typeId).some((id) => typeOf(id)?.owner === `mod:${modId}`);
  const frameworkOwned = (typeId) => chain(typeId).some((id) => typeOf(id)?.owner === 'framework');
  /** An operation whose answer is sensitive content (04 §6): its type declares it `content`. */
  const contentOp = (typeId, operation) => typeof operation === 'string' && typeOf(typeId)?.members?.operations?.get?.(operation)?.content === true;
  /** A mod on the framework's instances (S4). */
  function frameworkAllows(modId, use, typeId, ref) {
    if (use === 'read') return (ref?.type === 'Mod' && ref.id === modId) || covers(graphGrants(grantsOf(modId) ?? []).read, chain(typeId));
    if (use === 'contribute') return ref?.type === 'Mod' && ref.id === modId;   // a mod's own instance may name its own Mod (what defined it)
    return false;   // never acted on, intercepted or kept data on: the framework's instances are the user's (graph-boundary.md B5)
  }
  /** A mod on the settings the framework's provider serves (E3): its own, read with a grant otherwise, never acted on or intercepted. */
  function servedAllows(modId, use, typeId, ref, operation) {
    const c = chain(typeId);
    const isSetting = c.includes('Setting');
    const own = isSetting ? parseInstanceId(ref.id)?.modId === modId : ref.id === `mod:${modId}` || ref.id.startsWith(`mod:${modId}:`);
    if (use === 'intercept' || use === 'attach') return false;
    if (use === 'act') return own && isSetting && (operation === 'set' || operation === 'reset');
    if (use === 'contribute') return own || covers(graphGrants(grantsOf(modId) ?? []).contribute, c);
    if (own || (!isSetting && ref.id === 'codexmods')) return true;   // the Mods section is everyone's to see
    return covers(graphGrants(grantsOf(modId) ?? []).read, c);
  }
  /** A presentation of something the framework serves (E6, decision 6). */
  const frameworkPresentation = (typeId, ref) => {
    if (!ref || !chain(typeId).includes('Presentation')) return false;
    try { return subjectOf?.(ref)?.provider === FRAMEWORK_PROVIDER; } catch { return false; }
  };
  /**
   * May `caller` use the instance `ref` of type `typeId` for `use` ('read' | 'act' | 'intercept' | 'attach' | 'contribute': link its own
   * instances to it), with `operation` for act and intercept,
   * `_replaces` for an interceptor that answers in the operation's place (no rule asks it now: the framework's instances refuse every
   * interceptor), and `by` the caller of the operation an interceptor would see?
   */
  function allows(caller, use, typeId0, ref, operation, _replaces = false, by = null) {
    const modId = modIdOf(caller);
    if (modId === null) return true;                       // user, native, framework: their ingress authenticated them
    // an instance is authorized as what it is: a subtype a mod declares and names in a ref does not make another provider's instance its
    // own (review 2026-11-05 #2); one not known here is judged by the type named, with no shortcut for the types the mod declared
    const known = storedType(ref);
    const typeId = known ?? typeId0;
    if (use === 'intercept' && by?.kind === 'framework') return false;   // the framework's own calls pass no mod (B5)
    if (use !== 'read' && frameworkPresentation(typeId, ref)) return false;
    // a mod's tool (graph-integrity G3.5): its calls (Tool._call on `mod_<id>/<tool>`) are answered, and made, by its own mod only, with no
    // grant; registering to answer them is open to any mod, as each call decides by its tool (refereeing: whose a `mod_` name is)
    if (operation === '_call' && (use === 'intercept' || use === 'act') && chain(typeId).includes('Tool')) {
      if (ref === null || ref === undefined) return use === 'intercept';
      if (typeof ref.id === 'string' && ref.id.startsWith(TOOL_PREFIX)) return ref.id.startsWith(`${namespaceOf(modId)}/`);
    }
    if (frameworkOwned(typeId)) return frameworkAllows(modId, use, typeId, ref);
    if (ref?.provider === FRAMEWORK_PROVIDER && typeof ref.id === 'string') return servedAllows(modId, use, typeId, ref, operation);
    if (use !== 'intercept' && ref?.provider === modId && !RESERVED_PROVIDERS.has(modId)) return true;
    if (use !== 'act' && declared(modId, typeId) && (!ref || known !== null)) return true;
    const g = graphGrants(grantsOf(modId) ?? []);
    if ((use === 'act' || use === 'intercept') && contentOp(typeId, operation)) {
      // its answer is content: to call it, or to see it called, a grant must name it
      if (!covers(g.listed.act, chain(typeId), operation, true)) return false;
      if (use === 'act') return true;
    }
    return covers(use === 'read' ? g.read : use === 'act' ? g.act : use === 'attach' ? g.attach : use === 'contribute' ? g.contribute : g.intercept, chain(typeId), operation);
  }
  /**
   * May a mod relay the user's attested intent (graph-integrity G7.3) to act on `ref` with `operation`? Its own grant for the act decides,
   * as always; a setting the framework serves (another mod's: D1) needs the grant that covers it (`graph.act` for Setting.set or reset),
   * since only the user sets another mod's settings; the framework's own instances stay the user's alone.
   */
  function allowsAsUser(caller, typeId, ref, operation) {
    const modId = modIdOf(caller);
    if (modId === null) return false;
    if (ref?.provider === FRAMEWORK_PROVIDER && typeof ref.id === 'string' && !frameworkOwned(typeId) && chain(typeId).includes('Setting')) {
      return (operation === 'set' || operation === 'reset') && (servedAllows(modId, 'act', typeId, ref, operation) || covers(graphGrants(grantsOf(modId) ?? []).act, chain(typeId), operation));
    }
    return allows(caller, 'act', typeId, ref, operation);
  }
  return {
    allows,
    allowsAsUser,
    /** The runtime's `authorize(caller, {type, use, operation, ref, replaces, by})`. */
    authorize: (caller, req) => allows(caller, req.use, req.type, req.ref, req.operation, req.replaces === true, req.by ?? null),
    /** Can `caller` read this snapshot? */
    canRead: (caller, snap) => !!snap && allows(caller, 'read', snap.ref.type, snap.ref),
  };
}
