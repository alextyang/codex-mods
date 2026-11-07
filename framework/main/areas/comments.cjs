'use strict';
// The app's in-memory diff-comment drafts, shared by its held windows (breadth D7).
const crypto = require('node:crypto');
const kit = require('../area-kit.cjs');
const WRAPPED = Symbol.for('codexmods.comments.observer');
const threadId = (id) => typeof id === 'string' && !!id.trim() && id.length <= 200 && !id.startsWith('client-new-thread:');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function register(hooks) {
  let logged = false;
  function warn(error) {
    if (logged) return;
    logged = true;
    try { hooks.log?.warn('comments: observation failed', { message: String(error?.message ?? error) }); } catch { /* never break the app */ }
  }
  function report(conversationId, snapshot) {
    try {
      const comments = Array.isArray(snapshot) ? snapshot : snapshot?.comments;
      if (threadId(conversationId) && Array.isArray(comments)) hooks.areaReport('comments', { conversationId, comments });
    } catch (e) { warn(e); }
  }
  function wrap(svc) {
    if (svc[WRAPPED]) return;
    const originals = {};
    for (const name of ['edit', 'transfer', 'removeReviewThread']) if (typeof svc[name] === 'function') originals[name] = svc[name];
    svc[WRAPPED] = originals;
    for (const [name, original] of Object.entries(originals)) svc[name] = function (...args) {
      const answer = original.apply(this, args);
      try {
        if (name === 'edit') report(args[0], answer);
        else for (const entry of answer ?? []) report(entry.conversationId, entry.snapshot);
      } catch (e) { warn(e); }
      return answer;
    };
    if (svc.comments instanceof Map) for (const [id, comments] of svc.comments) report(id, comments);
  }
  function bind() {
    try {
      for (const w of hooks.appHost?.windows?.() ?? []) {
        try {
          const svc = w.host?.services?.commentAttachments;
          if (svc && typeof svc === 'object') wrap(svc);
        } catch (e) { warn(e); }
      }
    } catch (e) { warn(e); }
  }
  hooks.appHost?.subscribe?.(() => bind());
  bind();

  hooks.onAreaOp('comments', async (op, args = {}) => {
    if (op !== 'read' && op !== 'edit') throw kit.refusal(`unknown operation ${op}`);
    if (!threadId(args?.threadId)) throw kit.refusal('a thread id of at most 200 characters is needed');
    if (op === 'edit' && (!Array.isArray(args.removed) || args.removed.length > 100 || !args.removed.every(object)
      || !Array.isArray(args.added) || args.added.length > 100 || !args.added.every((a) => object(a) && object(a.comment) && Number.isInteger(a.index)))) {
      throw kit.refusal('removed and added must each have at most 100 comments; additions need an integer index');
    }
    const { svc } = kit.service(hooks, 'commentAttachments', ['subscribe', 'edit']);
    if (op === 'edit') {
      const answer = await kit.withTimeout(svc.edit(args.threadId, { id: crypto.randomUUID(), removed: args.removed, added: args.added }));
      return { comments: answer.comments };
    }
    let comments = [], heard = false;
    const stub = (snapshot) => { if (!heard) { comments = snapshot.comments; heard = true; } };
    stub.dup = () => stub;
    stub.onRpcBroken = () => {};
    stub[Symbol.dispose] = () => {};
    const subscription = svc.subscribe(args.threadId, stub);
    try { return { comments }; } finally { subscription.unsubscribe(); }
  });
}

module.exports = { register };
