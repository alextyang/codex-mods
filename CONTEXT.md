# Context

Shared vocabulary, as defined in [ARCHITECTURE.md](ARCHITECTURE.md).

| Term | Definition |
| --- | --- |
| **Stock app** | The user's unmodified `/Applications/ChatGPT.app`. A read-only input to the builder; the framework never modifies or launches it. |
| **Modded copy** | The launchable copy the builder makes from a stock build: its own bundle id, the loader, seam transforms, uniform signing. |
| **Builder** | The tool that produces, verifies and stages modded copies. |
| **Loader** | The only framework code inside the copy besides the relay. It takes the instance lock, runs the concurrency guard, and decides how to boot from flags and boot markers, or passes straight through. |
| **framework-main** | Framework code in Electron main: Host supervision, preload registration, views, relaunch, recovery prompts. Never mod code. |
| **Host** | The one framework process per running app. It owns the mux, mod runtime, state and management API. |
| **Mux** | The single owner of app↔app-server traffic: framing, ids, interceptors, observers, affinity, backends. |
| **Relay** | The minimal stdio↔socket pipe the app launches as its app-server. |
| **Backend** | An app-server process: the primary backend, or a named backend a mod defines. |
| **Logical client** | Anything the mux serves: the app, a mod, or an external client lease. |
| **Affinity** | The mux's record of which client and backend own a conversation key, read from catalog-declared paths. |
| **Adapter pack** | Per-build data: protocol catalog, anchors, components, theme tokens, seam transforms, probes. |
| **Anchor** | A named UI insertion point the adapter resolves, such as `settings.section` or `composer`. |
| **Mod** | An installed package with host and/or renderer entries, declared permissions and its own data. |
| **Adjustments** | The framework's management UI inside the app's Settings. |
| **Operation** | A journaled lifecycle change with an id and a truthful outcome. |
| **Generation** | The tuple of app build, framework, adapter, mods and settings that a boot runs. The last healthy one is LKG. |

## The object graph (planned)

SDK v2's vocabulary, as defined in [docs/graph/](docs/graph/README.md).

| Term | Definition |
| --- | --- |
| **Object graph** | The virtual model of the app's features that SDK v2 exposes. It is planned from what a user sees and does, not from the app's internals. |
| **Concept** | A type with a small core: what every instance has, whoever implements it. Thread, Project and Step are concepts. |
| **Subtype** | A type that extends a concept. The native implementation is one subtype among others: CodexThread extends Thread, and a mod's Claude Code thread extends it the same way. |
| **Provider** | What serves the instances of a type: their state, operations and capabilities. The native provider serves the native subtypes; a mod's provider serves the mod's. |
| **Capability** | A standard optional member (`name?`) that a provider declares it supports. An unsupported operation is refused and not offered. |
| **Presentation** | Something on screen that shows one instance, such as a SidebarItem or a ThreadView. Presentation types render concepts, so every subtype is shown the same way. |
| **Ref** | A stable reference to an instance: its type, its provider and its id. |
| **Graph operation** | Something that can be done with an instance, such as `thread.archive()`. It returns an outcome: done, refused, failed or uncertain. Not to be confused with a lifecycle **Operation** above. |

## Integration (planned)

How the graph runs on the app, as designed in docs/design/integration.md.

| Term | Definition |
| --- | --- |
| **Graph runtime** | The Host component that implements the graph's protocols: types, instances, refs, collections, operations, interception, permissions, attached data and each realm's view. |
| **Native provider** | The provider of the native subtypes. It draws each member from one source: the app-server protocol, the app's renderer↔main bus or AppHost, rendered props or the framework. |
| **AppHost** | The app's own internal API between each window and main: service objects main exports per window (projects, settings, read state, notifications, terminal, …) over a Cap'n Web session on the `connect-app-host` port, plus the `appActions` the window exports back. framework-main holds it at the listener that creates it. |
| **Realization map** | docs/design/realization/: for every type and presentation type, how it is read and acted on in the app, through which mechanism, at which evidence level (Scouted, Demonstrated, Proven). |
| **Registered view** | A subtype's own view of its instances (`ui.replace('ThreadView', { for })`), which the framework opens them to from every shared surface. The app's store holds only Codex's chats: the protocol presenter, which served mods' chats to the app as its own, was retired (graph-integrity D6). |
| **Presentation runtime** | The renderer component that binds presentation types to the app's UI through the app's own mechanics and the generic seams (JSX runtime, lazy chunks, descriptor-list taps). |
| **Census** | The per-build list of facts the native provider and the presentation runtime may rely on, derived automatically from the app's binaries and bundles. |
| **Need** | A census fact a native member depends on. A member whose needs are all present (and whose canary passes) is supported; otherwise it is unsupported. |
