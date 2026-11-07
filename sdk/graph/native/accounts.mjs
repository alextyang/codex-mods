// Native types, area A of docs/graph/02-types.md: Account, its subtype ChatGPTAccount, and Usage (breadth step D4). One definition per
// card, with the same builders a mod uses (define.mjs). Conventions are in threads.mjs. What is particular to these cards:
// - Account.agents is the inverse of CodexAgent.account. Account.usage and Usage.account are both written (one to one has no inverse).
// - Account.plugins and Account.toolServers are the inverses of Plugin.account and ToolServer.account (extensions.mjs, D10). PullRequest
//   is a type of a later step: a relation to its id until it is.
// - Usage's core is its account (graph-boundary.md B3): what limits are and how they are reported is each provider's own, on its subtype at
//   the source's fidelity. CodexUsage carries the server's rate-limit snapshots as given, keyed by their `limitId`, and reports each one
//   (graph-integrity G1): estimates, thresholds and resets are a mod's to derive.
import { defineConcept, defineSubtype, ev, op, r, s } from '../define.mjs';

export const Account = defineConcept('Account', {
  state: {
    service: s.string(),
    name: s.string(),
    signedIn: s.boolean(),
    email: s.string().optional(),
    plan: s.string().optional(),
  },
  relations: {
    usage: r.maybe('Usage'),
    agents: r.many('CodexAgent').inverse('account'), // the agents that use it: Codex's (an agent's account is its own, CodexAgent.account)
    threads: r.many('Thread').inverse('account').optional(), // the chats that run on it
    plugins: r.many('Plugin').inverse('account'),
    toolServers: r.many('ToolServer').inverse('account'),
    pullRequests: r.many('PullRequest').inverse('host'), // when it is a code host account
  },
  operations: {
    signIn: op(),
    signOut: op(),
    manage: op().optional(), // opens the service's account page
    remove: op().optional(), // an added account (RM10): signed out and removed; its chats move to the app's account
  },
  events: { signedIn: ev(), signedOut: ev(), planChanged: ev() },
  summary: { title: 'name', subtitle: 'service' },
});

export const ChatGPTAccount = defineSubtype(Account, 'ChatGPTAccount', {
  state: {
    workspace: s.string().optional(), // the team or organization the account works in
    added: s.boolean().optional(), // one the user added beside the app's own (RM10)
  },
});

export const Usage = defineConcept('Usage', {
  relations: { account: r.one('Account') },
  events: { changed: ev() },
});

// One of the server's rate-limit windows, as given: how much is used (percent), how long the window is, and when it resets (ms).
const WINDOW = s.object({ usedPercent: s.number(), windowDurationMins: s.number().optional(), resetsAt: s.time().optional() });
// A rate-limit snapshot as the server reports it (the protocol's RateLimitSnapshot). `limitId` is its identity; fields it has no schema
// for here are kept as given in `extra`.
const SNAPSHOT = s.object({
  limitId: s.string().optional(), limitName: s.string().optional(), primary: WINDOW.optional(), secondary: WINDOW.optional(),
  credits: s.object({ hasCredits: s.boolean(), unlimited: s.boolean(), balance: s.string().optional() }).optional(),
  planType: s.string().optional(), rateLimitReachedType: s.string().optional(), individualLimit: s.json().optional(),
  spendControlReached: s.json().optional(), normalModelSlug: s.string().optional(), extra: s.json().optional(),
});
export const CodexUsage = defineSubtype(Usage, 'CodexUsage', {
  state: {
    snapshots: s.record(SNAPSHOT), // by limitId (the snapshot without one: its key is the empty string)
    ordinaryUsageAllowed: s.boolean().optional(),
    rateLimitResetCredits: s.json().optional(),
  },
  events: { reported: ev(s.object({ snapshot: SNAPSHOT })) }, // every report as given, repeats included
});
