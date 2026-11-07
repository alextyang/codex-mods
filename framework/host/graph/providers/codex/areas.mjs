// The native provider's feature areas in their own modules (breadth.md D5, D10): each area is written, tested and declared apart, so areas
// can be built in parallel without touching the same files. Every areas/<name>.mjs is an area, named by its file (framework-main's module
// for the same area is framework/main/areas/<name>.cjs and registers the same name). index.mjs registers them, realizes.mjs merges their
// declarations, the realizes test takes each area's samples from test/areas/<name>.samples.mjs, and the fake app-server its modelled
// methods from tests/fixtures/fake-areas/<name>.mjs.
//
// An area module exports:
//   realizes: { types?, operations?, supports?, events?, links? }   its part of realizes.mjs (same shapes; lists merge into the core's)
//   types(feed: () => Feed): { [typeId]: { operations?: { [op]: OperationHandler } } }
//       its operation handlers; a type the core registers too gets these operations added to its own (two areas never define the same
//       operation). `feed()` is the area's feed once the source made it.
//   createFeed(ctx: AreaContext): Feed
//
// A Feed may have (all optional): notified(method, params) for every protocol notification of the primary backend; responded(method,
// result) for every answer the primary backend gives, the app's requests and the source's own (a free refresh of what the app read; a
// thread the answer names is already put); observe(ref, concept) → Promise | undefined
// when a realm observes a native ref (the first area that returns a promise loads it); start() once, when the source starts (the Host's
// source starts at the app-server's first ready); serverDown() and serverUp() around an app-server restart (every later ready); dispose(); `settings: { owns(ref), prompt(instance, change), write(ref, value), reset(ref) }`
// when the area puts Settings of its own (the core's Setting.set and reset hand them to it; R17 prompts come from `prompt`, with `change`
// `{op: 'set', value}` or `{op: 'reset'}`, so it can ask nothing for a write that would be refused or change nothing); and whatever its
// types' handlers call.
//
// AreaContext: { handle, graph, refs, log, now, resident(ref), safe(what, fn), emitEvent(ref, name, payload?),
//   request(method, params, intent?) (the source's own client; pass the operation's intent), serverUp() (false from a backend crash until
//   it is ready again), DOWN (the refusal while it is down), appState, appProjects, readState, bus,
//   mainOp(op, args) (framework-main's module for this area, graph/main-ops.mjs; refused without framework-main), onMainReport(fn),
//   cwdOf(threadId), threadIds(), loadThread(threadId) (the thread's turns into the graph), updateThread(threadId, state),
//   readRepository(projectId) (the project's GitRepository and branches read again, the app's way: after a commit or a staging),
//   pushRepository(projectId, branch?) (Repository.push, the app's way: null when pushed, a refusal, or it throws; a branch name given:
//   refused unless it is the one checked out when it is read),
//   withLoadedThread(threadId, fn, intent?) (fn() for a request the app-server answers only for a loaded thread: on "thread not found" or
//   "resume the thread before …" it
//   resumes the thread, as the app does when it opens a chat, and runs fn() once more), account() (the signed-in Account's ref, or null),
//   area(name) (another area's feed, or null) }.
//
// Order matters only for observe: the first area whose observe returns a promise takes the ref.
import { readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'areas');
const found = {};
for (const f of (() => { try { return readdirSync(DIR).filter((x) => x.endsWith('.mjs') && !x.endsWith('.test.mjs')).sort(); } catch { return []; } })()) {
  found[basename(f, '.mjs')] = await import(pathToFileURL(join(DIR, f)).href);
}
/** The areas, by name, in name order. */
export const AREAS = Object.freeze(found);
