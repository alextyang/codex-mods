# The Codex object graph

**Status:** in use: mods read and act on it as `ctx.graph` (the types in `sdk/graph/`, served by the framework's providers).

A virtual object graph of the Codex app, planned from what a user sees and does. It is the SDK's object model: mods use it as `ctx.graph`. It does
not mirror the app's internals, its wire protocol or its page structure, and it does not derive from the frozen SDK 2
(`frozen/sdk2-corrupt`, kept in the `archive` branch). docs/design/release-2.md is the release design
built on it.

Codex has no internal abstract models and was not designed to be extended. The framework defines the abstractions:
- **concepts** with small cores;
- **subtypes** that specialize them (the native Codex implementation is one subtype among others);
- **presentations**, objects of the graph that show any instance on screen.

A mod extends the graph with exactly the mechanisms the native app uses.

| File | Contents |
|---|---|
| [01-features.md](01-features.md) | The feature index: every user-facing feature, with the types and presentations that realize it |
| [02-types.md](02-types.md) | One card per type |
| [03-presentations.md](03-presentations.md) | One card per presentation type: what it presents, what it shows, its slots and operations |
| [04-protocols.md](04-protocols.md) | The shared protocols every type uses (identity, discovery, observation, operations and capabilities, interception, permissions, extension, presentation, lifecycle) |
| [05-graph.md](05-graph.md) | The overview diagrams |
| [06-review.md](06-review.md) | The decisions taken, the review checklist applied to every type, and what changed from the first draft |

`node scripts/graph-check.mjs` checks that the files name each other consistently (06, "Cross-check"); `npm test` runs it.

## Rules

1. **Traceability.** Every type traces to a feature in 01, and every feature to at least one type.
2. **Three tiers per concept:**
   - the **required core**, what every instance has, whoever implements it;
   - **standard optional members**, which have the same meaning for every implementation and are present when the provider supports them;
   - **subtype members**, which are specific to one implementation and live in a subtype that extends the concept.
3. **One extension contract.** Every type is extended the same way (04 §7): subtype it, provide instances, attach data, decorate its
   presentations, intercept its operations, replace an operation or a rendering. New concepts can be defined. The native app uses the same
   mechanisms. There are no exception types.
4. **Shared surfaces render the concept; a main view is its provider's** (2026-11-04, rule 8). Where the app shows several kinds side by side
   (the sidebar, search, the palette, notifications, the window title, the Dock, the new-chat agent picker, the Scheduled page), a
   presentation draws on the concept's core, its standard optional members and its summary, so every subtype joins it. A main view (a
   thread's conversation) belongs to the instance's provider: the app's own for Codex's, the view a mod registers for its own, built from
   the parts the framework lends (graph-integrity.md G2). The framework draws no generic view of a mod's
   data, and makes no provider's instances behave like another's.
5. **User vocabulary.** Names, state and operations use the user's words. Nothing names a backend message, a protocol field or a page
   element.
6. **Scope.** Server-side ChatGPT features outside Codex are out of scope. So are the framework's own objects (installed mods, consent,
   recovery), which get their own graph later, built the same way.
7. **Layers** (graph-layers.md, 2026-10-29). **Address data, declare UI.** The types of 02 are addressable:
   a mod holds their refs, acts on them and observes them. The presentation types of 03 are components a mod **declares into** (`ui.*`):
   a declaration applies wherever the component is drawn, in every window, until the mod stops; their live instances, and their
   operations and state, are the **mechanism** layer. The Window is the one addressable presentation. A member named `_name` is
   mechanism too: there, callable, not promised. Each type has an investment tier (supported, as built, mechanism:
   tiers.json), apart from rule 2's tiers.
8. **Ownership** (graph-boundary.md, accepted 2026-11-04). The framework is the app's API and the referee among the parties
   that share the app: it owns access to the app, joining its shared surfaces, refereeing (authority, order, attribution, merging an input
   several mods share), the guarantees a mod cannot give itself, and its own product. Anything with an opinion about what should happen is
   a mod's. A concept's core is what its shared surfaces and cross-provider authority need of every instance; what one implementation is
   made of, or reports beyond that, sits on its subtype at the source's fidelity.

## Card format

```
## Name                                           kind: concept | subtype | value
Purpose     one sentence, in the user's terms
Extends     the concept it specializes (subtypes only)      Subtypes: …
Identity    what makes one instance distinct
State       fields
Operations  what can be done with it
Events      what happens to it
Relations   to other types, with cardinality
Extension   which of the extension mechanisms apply (04 §7)
Presented   the presentation types that show it (03)
Notes       decisions and boundaries
```

**Notation:**

| Form | Meaning |
|---|---|
| `name: Type` | A required state field. |
| `name?: Type` | A standard optional field: present when the provider supports it, with the same meaning everywhere. |
| `name()` | A required operation. |
| `name?()` | An optional operation: the provider declares support for it (04 §4), and presentations hide it where it is not supported. |
| `name: Type (1)` | A relation to exactly one. |
| `name: Type (0..1)` | A relation to at most one. |
| `name: Type (*)` | A relation to any number. |
| `name: Type (1..*)` | A relation to at least one. |

Every operation returns an outcome (04 §4). Subtype cards list only what they add or change.
