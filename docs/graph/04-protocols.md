# 04 Shared protocols

Every type in 02 and every presentation in 03 uses these. They are written once here, and cards refer to them.

## 1. Identity and references
- Every instance has a stable **Ref**: its type, its provider (the native app or a mod) and an id unique within that provider.
- A Ref is how anything points at anything: relations, mentions, notifications, links in content, presentations' subjects.
- `resolve(ref)` returns the instance, or reports that it is gone.
- A Ref keeps its concept when the instance is a subtype: code that holds a `Ref<Thread>` can hold a Codex thread or a mod's thread.

## 2. Collections, search and reflection
**Collections:**
- Every type has a collection: `all()`, `find(id)`, `where(filter)`, `count()` and sorted views.
- A subtype's collection is part of its concept's: every Thread includes every CodexThread and every mod-defined thread.
- Relations are collections too: `project.threads`, `turn.steps`.

**Which instances.** One grammar (docs/design/public-hooks.md §3.1) says which instances everywhere a selection is made: collections,
views, presentation rules, filters, policies and defaults. Paths reach state fields, related instances (at most three hops) and a
mod's attached data; what cannot be resolved now, or may not be read, is unknown.

**Search:**
- `search(text, types?)` searches every **searchable** type. A type declares what it is searched by (its title, its content).
- The palette and the composer's menus are built on search (03).

**Reflection:**
- `types()` lists every type with its kind, its concept, its subtypes, and its members (state, operations, events, relations), each with
  its tier: core, standard optional or subtype (README rule 2); a mechanism member (`_name`, and a presentation instance's own operations
  and state, README rule 7) says so.
- `capabilities(instance)` lists the optional members and operations the instance supports (§4).
- The DetailView (03), a developer inspector shown in developer mode, is drawn from reflection. It is not a main view: a type is seen through
  the view its provider registers (README rule 4).

## 3. Observation
- **Read:** the current state of any instance, synchronously, from a local view of the graph.
- **Events:** subscribe to a type's events, for one instance, for a collection, or for a concept and all its subtypes.
- **Changes:** every state change is an event with the old and the new value.
- **Staleness:** an instance is live, stale (its source stopped reporting) or gone, and says which.

## 4. Operations, capabilities and outcomes
**Outcomes.** Every operation returns one:
- **done**, with a result;
- **refused**, with a reason: not allowed, unsupported, unavailable or invalid;
- **failed**, with an error;
- **uncertain:** it may or may not have happened, and it is never retried blindly (§10);
- **stopped**, by the mod named: an interceptor stopped it (§5). It did not happen, and nothing failed.

**Origin.** An operation is invoked by the user (through a presentation), by a mod or by an agent. The origin travels with it.

**Capabilities:**
- A provider declares, per subtype, which standard optional fields and operations it supports. Where support varies per instance (a
  thread that cannot be forked yet), the instance declares it.
- An unsupported field is absent, not empty. An unsupported operation is refused as unsupported.
- `can(instance, operation)` answers before trying. Changes of capability are events.
- Presentations offer only supported operations and show only present fields.

## 5. Interception and policy
- Before an operation runs, interceptors see it in priority order. Each can let it through, change its arguments, stop it or refuse it.
  A stop is not an error: the operation does not happen, and a mod that stopped it acts later as itself, from its own storage and the
  scheduler (graph-integrity.md G6).
- An interceptor decides in its own time, up to its deadline: it can ask the user with a Dialog (03) first. Nothing waits longer.
- Only an interceptor stops quietly: a graph caller gets `stopped`, an app place ends its action without an error and keeps its input (a
  composer its draft), and the subject gets an `operationStopped` event. A policy refuses, so the user sees why. An interceptor declares
  what its own failure means (`onFailure: allow | refuse`, allow the default); a failure never stops a call.
- A mod's call may carry a key of its own: the intent journal records it with the call's outcome and what it made, and what it made says
  it (a turn's `startedBy`). After an `uncertain` delivery the mod looks the key up (`made(key)`) before acting again.
- **Policies** are stored, declarative interceptors that run without mod code (for example "deny network approvals in this project").
- A mod's own calls skip its own interceptors.
- **Which origins pass interceptors.** Operations invoked through the graph always do. Whether operations started elsewhere (for example
  in a provider's own interface) do too depends on the provider, which declares it per operation; reflection shows it as
  `interceptable: any origin | graph only`.
- Interception is how requests are answered by policy, how a send is rewritten, how a deletion is confirmed.

## 6. Permissions
- The user grants what a mod may do, per type and per kind of use:
  - **read:** see instances;
  - **act:** invoke operations;
  - **present:** add to and act on presentations;
  - **contribute:** link its own instances to another provider's (`graph.contribute:<Concept>`, worded "adds to your chats"): a link
    to another provider's instance also needs **read** of that instance's type (graph-integrity G3.2);
  - **extend:** define, subtype, provide, intercept, replace.
- Sensitive content (message text, file contents, terminal output) is its own grant. An operation that answers it is declared
  `content` (`Terminal.tail`, a diff, a patch): a mod acts on it only with a grant that names it (`graph.act:Terminal.tail`), never
  with a bare or type-wide one.
- The native app is described in the same terms: its abilities are the full set.

## 7. Extension
**The mechanisms.** `define` adds a concept to the graph. The other six apply to every type unless its card says otherwise, and the native
Codex implementation uses the same ones.

| Mechanism | What it does | Example |
|---|---|---|
| **define** | Define a new concept, with its own core, optional members, operations, events and relations to existing types | a mod defines Deployment, related to Project and Thread |
| **subtype** | Define a new kind of a concept, with added state, operations and events | a Claude Code thread is a subtype of Thread |
| **provide** | Serve instances of a type or a subtype: their state, their operations, their capabilities | a mod serves its Claude Code threads; they join `Thread.all()` |
| **attach** | Add a mod's own named values to any instance, kept by the framework: private to the mod unless shared (public-hooks.md §3.3); a mod's settings of a chat or a project are its declared values there | a mod tags threads with a ticket number |
| **contribute** | Serve instances linked to another provider's, found through the target's relations: put when someone reads them (§7 Contributions) | a mod's per-chat Setting, found in the chat's `settings` |
| **decorate** | Add to an instance's presentations | a badge on a thread's sidebar item |
| **intercept** | Observe, change, stop or refuse operations (§5) | refuse sends that mention a secret file |
| **replace** | Supply the implementation of an operation, or the rendering of a presentation, for chosen instances | render CommandRun blocks as a richer view |

**Rules:**
- **Inheritance.** A subtype inherits its concept's members, events, relations and presentations. It overrides only what it must, and
  code written against a concept works on every subtype.
- **Deeper subtypes.** A subtype can be subtyped. To add to instances someone else serves, use attach, decorate and intercept. To make a
  new kind whose instances you serve, subtype.
- **Containment.** Owned parts are served by their owner's provider:
  - a thread's turns, messages, steps, requests and changes;
  - a plan's tasks;
  - a change set's files and hunks;
  - a review's findings.

  A mod's agent serves the parts others address: its requests (answered anywhere, shown in the shared surfaces) and its turns (stopped,
  attributed), and its messages and steps when it wants other mods to read or intercept them. Its own view draws from its own data with
  the lent parts (README rule 4).
- **Joined.** A provided instance appears in collections and search, and in the shared surfaces its concept joins: listed, opened to the
  view its provider registers, and acted on where `can` allows. Other mods can decorate and intercept it. It behaves as its provider makes
  it: the framework implements nothing on its behalf (README rules 4 and 8).
- **Defined concepts** get collections, search when searchable, observation, operations and outcomes, interception and permissions, like
  any concept, and are seen through the views their mod registers. They join existing types through relations, and existing types can show them through attach and decorate.
- **Order.** Interceptors and decorations apply in a priority order the user can change. Where two mods replace the same thing for the
  same instance, the first in that order wins and the other is told.
- **Discovery.** Everything a mod defines is visible through reflection (§2).

**Contributions** (graph-integrity G3).
- A contribution is an instance a provider puts whose link names another provider's instance. It is its contributor's own: its provider,
  its handlers, its lifetime; when the contributor stops, its contributions go. Inverse relations, queries and `referrers` include them
  as anything else.
- **Authority.** The link needs read of the target's type and `graph.contribute` for its concept (§6); without them the put is refused.
  A mod's own instances may name its own Mod (what defined them) without one.
- **Materialized on reading.** A provider declares what it contributes (`contributes: [{type, via}]`). Before anyone reads that inverse
  relation of an instance (a chat's `settings`), or lists the type pinned to one (`{thread: ref}`), the runtime asks it for its
  contributions to that instance (`onObserve({target, relation})`), within the read's deadline. This, not a naming convention, is how
  consumers find them.
- **Relations to several concepts.** A relation may name a list of concepts (`r.one(['App', 'Agent', 'Plugin', 'Skill', 'Mod'])`):
  any of their instances, and no other. Queries filter on it and `referrers` answers it (`Setting where definedBy = it`).

## 8. Presentation
- **Presentations are components** (03): a mod declares into them (`ui.*`); their live instances are graph objects of the mechanism
  layer (README rule 7), and the Window is addressable.
- **Summary.** Every concept gives its instances a summary: `{ title, subtitle?, icon?, status?, badges?, time? }`.
  - The shared surfaces render it: sidebar items, palette results, menu entries, chips, banners.
  - A subtype can refine its summary, and a mod can decorate it.
- **Mentionable** types appear in the composer's mention menu and become Mentions. **Searchable** types appear in the palette.
- **Where an instance is shown.** Every instance has a `presentations` relation: its live presentations in every window (mechanism).
- **Navigation.** `Window.open(ref)` shows the main view of the instance's type (the app's own for native types, the one its mod
  registers otherwise) and sets `Window.current`, with back and forward history.
- **Generic operations** on every presentation: `_read`, add, decorate, replace, hide, reorder, `_act`, style, host (03).
- **Look.** Rendering uses the app's own components and the Theme's tokens. A mod's hosted UI is built from the same components, so it
  follows theme changes.
- **Lifetime.** A presentation is tied to its subject: when the subject goes away, so do its presentations.

## 9. Lifecycle and persistence
- Create, archive and delete follow the type's operations and are intercepted like any other.
- Owned parts go with their owner.
- A provider owns its instances' storage. The framework keeps attached data and a mod's own data. When the mod is removed, the user chooses
  whether that data is kept or deleted.
- After a restart, instances come back from their providers and refs stay valid.

## 10. Uncertainty and time
- Effects that leave the app are recorded before they start: a command, a push, a message to an outside service.
- If the app stops in the middle, the outcome is **uncertain**. It is surfaced once and never replayed.
- Every event carries the time it happened and the order in which it was observed.
