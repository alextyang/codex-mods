// The native type library for C2 (docs/design/runtime-core.md R2) and V14 (docs/design/presentations.md): Agent, CodexAgent and Model; Thread,
// Turn, Message and Draft; Step and Request with their subtypes, as docs/graph/02-types.md describes them, defined with the builders a mod
// uses (../define.mjs). `NATIVE_TYPES` lists every definition, each concept before its subtypes; the runtime loads
// `NATIVE_TYPES.map(toDescriptor)`.
//
// Writing the cards down found name collisions, fixed in the cards (2026-10-21, and 2026-10-25 for area F): Reasoning.thinking and
// Review.overview (were `summary`, which every instance has), ChangeSet.fileCount (was `files`, also its relation), WebLookup.pageTitle
// (was `title`, which Step has), Thread.enqueue (was `queue`, also a relation), and ToolApproval's tool, which is the inherited Request.tool. What still differs from the cards, with a comment at the definition:
// - Thread.send, Draft.insert and Model._select take one kind of argument, and Thread.review, Draft.attach and Draft.send take or return
//   any JSON (a ref to one of several types): the schemas have no union;
// - an Image is a string, a symbol name or a url (Agent.icon, agents.mjs).
// Relations to types that are not in this library yet (ChangeSet, Tool, Setting, ...) are kept as relations to their id. Project and
// LocalProject (area B, projects.mjs), Folder, File (area G, files.mjs), ExternalApp (apps.mjs), the environments (environments.mjs) and Repository, GitRepository and Branch (git.mjs), Instructions (instructions.mjs), and Command with ProjectAction (commands.mjs) joined in
// breadth step D3; App, Theme and Update (app.mjs), Setting and SettingsSection (settings.mjs), Account, ChatGPTAccount and Usage
// (accounts.mjs) in D4; ToolServer, Tool, Plugin and Skill (extensions.mjs) in D10; for D6-D9 Shortcut (commands.mjs), ChangeSet,
// FileChange, Hunk, Comment, Review and Finding (changes.mjs), Commit, PullRequest and GitHubPullRequest (git.mjs), Terminal, BrowserTab
// and ComputerUseSession (tools.mjs), Automation and Notification (attention.mjs). Review.target and reviewer, Automation.schedule and
// Notification.source are any JSON (a ref or a value of one of several kinds): the schemas have no union.
import { Agent, CodexAgent, Model } from './agents.mjs';
import { Thread, CodexThread, Turn, CodexTurn, Message, UserMessage, Attachment, Mention, AgentMessage, Draft, QueuedMessage } from './threads.mjs';
import { Step, Reasoning, PlanTask, Plan, CommandRun, FileEdit, Search, WebLookup, ToolCall, ComputerAction, Delegation, CodexCommandRun, CodexToolCall, CodexReasoning, CodexStep } from './steps.mjs';
import { Request, Approval, CommandApproval, CodexCommandApproval, EditApproval, NetworkApproval, ToolApproval, ComputerUseApproval, Question, CodexQuestion } from './requests.mjs';
import { Project, LocalProject } from './projects.mjs';
import { Folder, File } from './files.mjs';
import { ExternalApp } from './apps.mjs';
import { Environment, LocalEnvironment, WorktreeEnvironment, CloudEnvironment } from './environments.mjs';
import { Repository, GitRepository, Branch, Commit, PullRequest, GitHubPullRequest } from './git.mjs';
import { Instructions, CodexInstructions } from './instructions.mjs';
import { Command, ProjectAction, SlashCommand, Shortcut } from './commands.mjs';
import { ToolServer, Tool, Plugin, Skill } from './extensions.mjs';
import { ChangeSet, FileChange, Hunk, Comment, Review, Finding } from './changes.mjs';
import { Terminal, BrowserTab, ComputerUseSession } from './tools.mjs';
import { Automation, Notification } from './attention.mjs';
import { App, Theme, Update } from './app.mjs';
import { Setting, SettingsSection } from './settings.mjs';
import { Account, ChatGPTAccount, Usage, CodexUsage } from './accounts.mjs';

export {
  Agent, CodexAgent, Model,
  Thread, CodexThread, Turn, CodexTurn, Message, UserMessage, Attachment, Mention, AgentMessage, Draft, QueuedMessage,
  Step, Reasoning, PlanTask, Plan, CommandRun, FileEdit, Search, WebLookup, ToolCall, ComputerAction, Delegation,
  CodexCommandRun, CodexToolCall, CodexReasoning, CodexStep,
  Request, Approval, CommandApproval, CodexCommandApproval, EditApproval, NetworkApproval, ToolApproval, ComputerUseApproval, Question, CodexQuestion,
  Project, LocalProject, Folder, File, ExternalApp,
  Environment, LocalEnvironment, WorktreeEnvironment, CloudEnvironment, Repository, GitRepository, Branch, Instructions, CodexInstructions,
  Command, ProjectAction, SlashCommand, Shortcut,
  App, Theme, Update, Setting, SettingsSection, Account, ChatGPTAccount, Usage, CodexUsage,
  ToolServer, Tool, Plugin, Skill,
  ChangeSet, FileChange, Hunk, Comment, Review, Finding, Commit, PullRequest, GitHubPullRequest,
  Terminal, BrowserTab, ComputerUseSession, Automation, Notification,
};

/** Every native definition, a concept before each of its subtypes. */
export const NATIVE_TYPES = Object.freeze([
  Agent, CodexAgent, Model,
  Thread, CodexThread, Turn, CodexTurn, Message, UserMessage, Attachment, Mention, AgentMessage, Draft, QueuedMessage,
  Step, Reasoning, PlanTask, Plan, CommandRun, FileEdit, Search, WebLookup, ToolCall, ComputerAction, Delegation,
  CodexCommandRun, CodexToolCall, CodexReasoning, CodexStep,
  Request, Approval, CommandApproval, CodexCommandApproval, EditApproval, NetworkApproval, ToolApproval, ComputerUseApproval, Question, CodexQuestion,
  Project, LocalProject, Folder, File, ExternalApp,
  Environment, LocalEnvironment, WorktreeEnvironment, CloudEnvironment, Repository, GitRepository, Branch, Instructions, CodexInstructions,
  Command, ProjectAction, SlashCommand, Shortcut,
  App, Theme, Update, Setting, SettingsSection, Account, ChatGPTAccount, Usage, CodexUsage,
  ToolServer, Tool, Plugin, Skill,
  ChangeSet, FileChange, Hunk, Comment, Review, Finding, Commit, PullRequest, GitHubPullRequest,
  Terminal, BrowserTab, ComputerUseSession, Automation, Notification,
]);
