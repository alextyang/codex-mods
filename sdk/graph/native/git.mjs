// Native types, area F of docs/graph/02-types.md: Repository, GitRepository and Branch (breadth step D3: a project's version control),
// Commit, PullRequest and GitHubPullRequest (D7). One definition per card, with the same builders a mod uses (define.mjs). Conventions are
// in threads.mjs. What is particular to these cards:
// - `currentBranch?: Branch` is on the card's state line; Branch is a concept, so it is a relation (an optional one), as Thread.model is.
// - Repository.branches, commits and pullRequests are the inverses of Branch.repository, Commit.repository and PullRequest.repository;
//   Account.pullRequests (accounts.mjs) of PullRequest.host. Branch.pullRequest names a branch's open one (a branch can have had several):
//   not an inverse.
// - A Repository's identity is its project; a Branch's is its repository and its name; a Commit's its repository and its id; a PullRequest's
//   its url. GitHubPullRequest adds what the app shows of a GitHub pull request (its reviewers).
import { defineConcept, defineSubtype, ev, op, r, s } from '../define.mjs';

export const Repository = defineConcept('Repository', {
  state: {
    kind: s.string(),
    dirty: s.boolean(),
    remotes: s.list(s.object({ name: s.string(), url: s.string() })),
  },
  relations: {
    project: r.one('Project'),
    currentBranch: r.maybe('Branch').optional(),
    branches: r.many('Branch').inverse('repository'),
    commits: r.many('Commit').inverse('repository'),
    pullRequests: r.many('PullRequest').inverse('repository'),
  },
  operations: {
    commit: op({ args: [s.string().optional(), s.list(s.string()).optional()], returns: r.one('Commit') }),
    switchBranch: op({ args: [s.ref('Branch')] }),
    createBranch: op({ args: [s.string()], returns: r.one('Branch') }),
    // the branch pushed: the current one when not named (the user's push names the branch it pushes, a worktree's its own)
    push: op({ args: [s.ref('Branch').optional()] }).optional(),
    pull: op().optional(),
    fetch: op().optional(),
    // its unstaged (default), staged or branch changes as one unified diff, as the app's review shows them (untracked files included)
    workingChanges: op({ args: [s.enum('unstaged', 'staged', 'branch').optional()], returns: s.string(), content: true }).optional(),
    // these files' working changes thrown away (their unstaged ones, by default; `staged`: their staged ones too), as the app's review
    // reverts a file, a part of one or a section (H6m4: a part of a file is its file here)
    discard: op({ args: [s.list(s.string()), s.enum('unstaged', 'staged').optional()] }).optional(),
  },
  events: { branchChanged: ev(), statusChanged: ev(), committed: ev(), pushed: ev() },
  summary: { title: 'kind' },
});

export const GitRepository = defineSubtype(Repository, 'GitRepository', {
  state: { staged: s.list(s.string()) }, // paths
  operations: { stage: op({ args: [s.list(s.string())] }), unstage: op({ args: [s.list(s.string())] }) },
});

export const Branch = defineConcept('Branch', {
  state: {
    name: s.string(),
    current: s.boolean(),
    ahead: s.number().optional(),
    behind: s.number().optional(),
    upstream: s.string().optional(),
  },
  relations: {
    repository: r.one('Repository'),
    pullRequest: r.maybe('PullRequest'),
  },
  operations: {
    switch: op(), push: op().optional(), delete: op().optional(),
    // a pull request of this branch, on its repository's code host (H6m4: the app's "Create pull request" names the branch it opens)
    openPullRequest: op({ args: [s.object({ base: s.string().optional(), title: s.string().optional(), body: s.string().optional(), draft: s.boolean().optional() }).optional()],
      returns: r.one('PullRequest') }).optional(),
  },
  summary: { title: 'name' },
});

export const Commit = defineConcept('Commit', {
  state: {
    id: s.string(),
    message: s.string(),
    author: s.string(),
    time: s.time(),
    files: s.number(),
  },
  relations: {
    repository: r.one('Repository'),
    branch: r.maybe('Branch'),
    thread: r.maybe('Thread'),
  },
  operations: { open: op() },
  summary: { title: 'message', subtitle: 'author' },
});

export const PullRequest = defineConcept('PullRequest', {
  state: {
    title: s.string(),
    state: s.enum('draft', 'open', 'merged', 'closed'),
    url: s.url(),
    number: s.number().optional(),
    checks: s.enum('passing', 'failing', 'pending', 'none').optional(),
    reviewState: s.enum('approved', 'changesRequested', 'pending').optional(),
  },
  relations: {
    repository: r.one('Repository'),
    branch: r.one('Branch'),
    thread: r.maybe('Thread'),
    host: r.maybe('Account'),
    comments: r.many('Comment'),
  },
  operations: {
    open: op(), // on the web
    refresh: op(),
    markReady: op().optional(),
    merge: op().optional(),
  },
  events: { stateChanged: ev(), checksChanged: ev() },
  summary: { title: 'title', subtitle: 'state' },
});

export const GitHubPullRequest = defineSubtype(PullRequest, 'GitHubPullRequest', {
  state: { reviewers: s.list(s.string()).optional() },
});
