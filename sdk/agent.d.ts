// What the agent gets from a mod (graph-integrity G3.5): SDK conveniences built only on the graph's public primitives (sdk/agent.mjs).
// Each intercepts the agent's inputs (the source's own acts) and adds this mod's part, in the user's order with other mods'.
import type { AgentScope, AgentTool, Disposable, GraphRef, HostContext } from './index.js';

/**
 * Instructions the agent follows: a text joins the developer instructions of each thread's start, resume (one that sends instructions)
 * and fork, once, marked as this mod's; a function's text goes with each turn as context under `mod:<id>`, in the threads `scope` keeps
 * (`project`; and `where`, a where on the thread, which may read this mod's attached data: a role). Needs `graph.intercept` and
 * `graph.act` for `CodexAgent._startThread`, `CodexThread._resume` and `Thread.fork` (a text), or `Thread.send` (a function).
 */
export declare function instructions(ctx: HostContext, text: string | ((env: { readonly thread: Required<GraphRef> }) => string | Promise<string>),
  opts?: { scope?: AgentScope }): Disposable;
/**
 * A tool the agent may call in the threads started from now on, under this mod's namespace; only this mod answers its calls, and while it
 * is off the framework answers that it is not running. Needs `graph.intercept` and `graph.act` for `CodexAgent._startThread`.
 */
export declare function tool(ctx: HostContext, tool: AgentTool): Disposable;
/**
 * A folder of skills for the agent in every chat (`<folder>/<skill>/SKILL.md`), an absolute path or a file URL: added whenever the
 * session's skill roots are set, and set now (`ready`). Needs `graph.intercept` and `graph.act` for `CodexAgent._setSkillRoots`.
 */
export declare function skills(ctx: HostContext, folder: string | URL): Disposable & { readonly ready: Promise<void> };
