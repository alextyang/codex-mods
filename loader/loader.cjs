// codexmods loader (ARCHITECTURE.md 4.1, 5, 12.4).
//
// The builder prepends this file to `require(<original main>)` inside the app's asar and substitutes the
// placeholder string assigned to BAKED_ROOT below. It is synchronous CommonJS with no dependencies and no framework code: it must keep
// working when everything under framework/ is broken. Together with electron-adapter.cjs it is the only file
// that requires 'electron'.
//
// Path names here mirror contracts/layout.mjs (loader.test.mjs checks parity).
(function codexmodsLoader() {
  'use strict';
  var fs = require('fs');
  var path = require('path');
  var BAKED_ROOT = '__CODEXMODS_ROOT__';
  var env = process.env;
  var root = env.CODEX_MODS_ROOT || BAKED_ROOT;
  var profileName = env.CODEX_MODS_PROFILE || 'default';

  var profileDir = path.join(root, 'profiles', profileName);
  var L = {
    framework: path.join(root, 'framework'),
    frameworkCurrent: path.join(root, 'framework', 'current'),
    frameworkLkg: path.join(root, 'framework', 'lkg'),
    lkgApp: path.join(profileDir, 'lkg-app'),       // v1.6: this profile's LKG copy (text file: absolute path)
    userData: path.join(profileDir, 'userData'),
    codexHome: path.join(profileDir, 'codex-home'),
    profileConfig: path.join(profileDir, 'profile.json'),
    flags: path.join(profileDir, 'flags'),
  };
  var stage = 'start';

  function mkdirp(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch (e) { return null; } }
  function exists(file) { try { fs.lstatSync(file); return true; } catch (e) { return false; } }
  /** temp file + rename in the same directory (synchronous counterpart of fsutil.writeJsonAtomic). */
  function writeAtomic(file, text) {
    mkdirp(path.dirname(file));
    var tmp = path.join(path.dirname(file), '.' + process.pid + '-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.tmp');
    var fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ } throw e; }
  }
  function writeJson(file, value) { writeAtomic(file, JSON.stringify(value, null, 2) + '\n'); }
  function readJsonOrNull(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } }
  function isDir(file) { try { return fs.statSync(file).isDirectory(); } catch (e) { return false; } }
  /** Canonical path of the .app bundle containing execPath, or null. */
  function canonical(p) { try { return fs.realpathSync(p); } catch (e) { return path.resolve(p); } }
  function bundleOf(execPath) { var m = /^(.*?\.app)(?:\/|$)/.exec(String(execPath || '')); return m ? canonical(m[1]) : null; }
  function validVersion(v) { return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(v); }

  // ---- Per-profile instance lock (v1.8): two instances on one profile (e.g. an older candidate opened from the Dock) would fight over
  // boot.json and the Host sockets. <profileDir>/run/instance.lock is created exclusively with {pid, startedAt, appPath, token}.
  // A lock whose pid is dead is taken over under a reaper mutex (mkdir <lock>.reap), the same pattern as the package store lock.
  var lockFile = path.join(profileDir, 'run', 'instance.lock');
  var lockWaitMs = Number(env.CODEX_MODS_INSTANCE_WAIT_MS);
  if (!(lockWaitMs >= 0)) lockWaitMs = 3000;       // a relaunching predecessor may still be exiting
  function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; } }
  function sleepMs(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { var end = Date.now() + ms; while (Date.now() < end) { /* spin */ } } }
  function readLock() {
    var raw;
    try { raw = fs.readFileSync(lockFile, 'utf8'); } catch (e) {
      if (e && e.code === 'ENOENT') return { missing: true };
      return { garbage: true, old: false };                 // unreadable but present: respect it like a half-written lock
    }
    try { var o = JSON.parse(raw); if (o && Number.isInteger(o.pid)) return { owner: o }; } catch (e) { /* garbage */ }
    var age; try { age = Date.now() - fs.statSync(lockFile).mtimeMs; } catch (e) { return { missing: true }; }
    return { garbage: true, old: age > 5000 };
  }
  /** Stale: dead owner, our own pid (a previous incarnation of this process), or old garbage. */
  function lockIsStale(r) { return r.garbage ? r.old : (!!r.owner && (r.owner.pid === process.pid || !pidAlive(r.owner.pid))); }
  function reapStaleLock() {
    var reap = lockFile + '.reap';
    try { fs.mkdirSync(reap, { mode: 0o700 }); } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(reap).mtimeMs > 30000) fs.rmdirSync(reap); } catch (e2) { /* raced */ }
      return;                                      // someone else is reaping: the caller loops
    }
    try {
      var r = readLock();
      if (!r.missing && lockIsStale(r)) { try { fs.unlinkSync(lockFile); } catch (e) { /* gone */ } }   // re-judged under the mutex
    } finally { try { fs.rmdirSync(reap); } catch (e) { /* ignore */ } }
  }
  /** @returns {{held:false, file:string, token:string} | {held:true, owner:object}} */
  function acquireInstanceLock() {
    mkdirp(path.dirname(lockFile));
    var token = Date.now().toString(16) + '-' + process.pid + '-' + Math.random().toString(16).slice(2);
    var deadline = Date.now() + lockWaitMs;
    var vanished = 0;
    for (;;) {
      try {
        var fd = fs.openSync(lockFile, 'wx', 0o600);
        try {
          fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), appPath: process.execPath || null, token: token }));
          fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
        return { held: false, file: lockFile, token: token };
      } catch (e) { if (!e || e.code !== 'EEXIST') throw e; }
      try { if (fs.lstatSync(lockFile).isDirectory()) throw new Error('instance.lock is a directory'); } catch (e) { if (e && e.code !== 'ENOENT') throw e; }
      var r = readLock();
      if (r.missing) { if (++vanished > 50) throw new Error('instance.lock keeps vanishing'); continue; }
      if (lockIsStale(r)) { reapStaleLock(); continue; }
      if (Date.now() >= deadline) return { held: true, owner: r.owner || {} };
      sleepMs(50);
    }
  }
  function releaseInstanceLock(lock) {
    if (!lock || lock.held || !lock.file) return;
    try { var r = readLock(); if (r.owner && r.owner.token === lock.token) fs.unlinkSync(lock.file); } catch (e) { /* ignore */ }
  }


  // ---- Concurrency guard (v1.13, owner decision: warn but allow). Independent of framework availability: before app main, when the
  // profile asks for it (guardStockApp), look for (a) the stock ChatGPT app and (b) a Codex app-server of this user that is not
  // ours and uses this profile's CODEX_HOME. Found, or inspection failed -> one native dialog once the app is ready ("Continue
  // anyway" is the default). Every decision is logged to <profileDir>/logs/guard.log.
  var STOCK_EXECUTABLE = '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT';
  function envValue(rest, name) {
    var m = new RegExp('(?:^|\\s)' + name + '=(.*?)(?=\\s[A-Za-z_][A-Za-z0-9_]*=|$)').exec(rest);
    return m ? m[1] : null;
  }
  /** The executable path plus argv of a `ps eww` command text: everything before the environment block (never the pid). */
  function psCommand(rest) {
    var m = /\s[A-Z_][A-Z0-9_]*=/.exec(rest);
    return (m ? rest.slice(0, m.index) : rest).replace(/\s+/g, ' ').trim();
  }
  var STOCK_FINGERPRINT = '/Applications/ChatGPT.app';
  /**
   * @returns {{failed:boolean, unknown:boolean, reasons:string[], conflicts:{kind:'stock'|'cli'|'unknown', pid:number, fingerprint:string}[]}}
   * Processes whose fingerprint is in `trusted` (profile.guardTrusted) are ignored; unreadable-environment processes and failed
   * inspections are never ignorable.
   */
  function detectConcurrency(codexHome, runDir, trusted) {
    var out;
    try {
      var args = ['eww', '-o', 'pid=,command='];
      if (typeof process.getuid === 'function') args.push('-U', String(process.getuid()));
      out = require('child_process').execFileSync('/bin/ps', args, { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 * 1024 });
    } catch (e) { return { failed: true, unknown: false, conflicts: [], reasons: ['could not inspect running processes (' + String(e && e.message || e).slice(0, 120) + ')'] }; }
    var reasons = [], conflicts = [];
    var unknown = false;
    var wantHome = path.resolve(codexHome);
    var defaultHome = path.join(require('os').homedir(), '.codex');
    String(out).split('\n').forEach(function (line) {
      var m = /^\s*(\d+)\s(.*)$/.exec(line);
      if (!m) return;
      var pid = Number(m[1]), rest = m[2];
      if (rest === STOCK_EXECUTABLE || rest.indexOf(STOCK_EXECUTABLE + ' ') === 0) {
        reasons.push('the stock ChatGPT app is running (pid ' + pid + ')');
        conflicts.push({ kind: 'stock', pid: pid, fingerprint: STOCK_FINGERPRINT });
        return;
      }
      if (!/(?:^|\/)codex\s/.test(rest) || !/\sapp-server(?:\s|$)/.test(rest)) return;      // a codex binary running app-server
      var fp = psCommand(rest);
      if (!/(?:^|\s)(?:HOME|PATH|USER)=/.test(rest)) {
        unknown = true; reasons.push('a Codex app-server (pid ' + pid + ') could not be inspected: its environment is unreadable');
        conflicts.push({ kind: 'unknown', pid: pid, fingerprint: fp });
        return;
      }
      if (envValue(rest, 'CODEX_MODS_RUN_DIR') === runDir) return;                          // ours
      var home = envValue(rest, 'CODEX_HOME');
      if (path.resolve(home === null || home === '' ? defaultHome : home) !== wantHome) return;
      if (trusted.indexOf(fp) >= 0) return;                                                  // the owner chose "Always allow this server"
      reasons.push('another Codex app-server (pid ' + pid + ') is using this Codex home');
      conflicts.push({ kind: 'cli', pid: pid, fingerprint: fp });
    });
    return { failed: false, unknown: unknown, reasons: reasons, conflicts: conflicts };
  }
  function uniqueFingerprints(conflicts) {
    var seen = {}, out = [];
    conflicts.forEach(function (c) { if (!seen[c.fingerprint]) { seen[c.fingerprint] = true; out.push(c.fingerprint); } });
    return out;
  }
  // ---- v1.19: framework-initiated relaunches inherit the owner's last explicit decision.
  var INTENT_MAX_AGE_MS = 10 * 60 * 1000;
  var intentFile = path.join(profileDir, 'run', 'relaunch-intent.json');
  var lastContinueFile = path.join(profileDir, 'run', 'guard-last-continue.json');
  /** One-shot: the token is removed whether or not it is valid. True when it was written by framework-main within 10 minutes. */
  function consumeRelaunchIntent() {
    var raw = readText(intentFile);
    if (raw === null) return false;
    try { fs.unlinkSync(intentFile); } catch (e) { /* gone */ }
    try {
      var t = JSON.parse(raw);
      var age = Date.now() - Date.parse(t && t.at);
      return Number.isFinite(age) && age >= -60000 && age <= INTENT_MAX_AGE_MS;
    } catch (e) { return false; }
  }
  function readLastContinue() {
    var j = readJsonOrNull(lastContinueFile);
    return j && Array.isArray(j.fingerprints) ? j.fingerprints.filter(function (f) { return typeof f === 'string'; }) : [];
  }
  function writeLastContinue(fingerprints) { try { writeJson(lastContinueFile, { at: new Date().toISOString(), fingerprints: fingerprints }); } catch (e) { /* a courtesy */ } }
  function clearLastContinue() { try { fs.unlinkSync(lastContinueFile); } catch (e) { /* none */ } }
  /** profile.json guardTrusted[] += fingerprints (atomic; every other field kept). Mirrors framework/main/guard-trust.cjs. */
  function trustFingerprints(fingerprints) {
    try {
      var current = readJsonOrNull(L.profileConfig) || {};
      var list = Array.isArray(current.guardTrusted) ? current.guardTrusted.filter(function (f) { return typeof f === 'string'; }) : [];
      fingerprints.forEach(function (f) { if (list.indexOf(f) < 0) list.push(f); });
      current.guardTrusted = list;
      writeJson(L.profileConfig, current);
      return true;
    } catch (e) { return false; }
  }
  function guardLog(entry) {
    try {
      mkdirp(path.join(profileDir, 'logs'));
      fs.appendFileSync(path.join(profileDir, 'logs', 'guard.log'), JSON.stringify(Object.assign({ t: new Date().toISOString() }, entry)) + '\n', { mode: 0o600 });
    } catch (e) { /* a courtesy */ }
  }
  // A guard exit (Quit, dialog failure, unexpected result) is not a boot attempt: it must leave the boot marker (and the safe flag this
  // launch may have written) exactly as it was before this launch, so only real boot attempts count toward unhealthyCount.
  var deferredBegin = null;     // framework-main's begin(), held back while the concurrency warning is pending
  var bootUndo = null;      // { markerFile, markerRaw (null = absent), safeFile, safeWritten }
  function undoThisLaunchsBootState() {
    if (!bootUndo) return;
    var u = bootUndo; bootUndo = null;
    try { if (u.markerRaw === null) fs.unlinkSync(u.markerFile); else writeAtomic(u.markerFile, u.markerRaw); } catch (e) { /* best effort */ }
    try { if (u.safeWritten) { if (u.safeRaw === null) fs.unlinkSync(u.safeFile); else writeAtomic(u.safeFile, u.safeRaw); } } catch (e) { /* best effort */ }
  }
  // ---- v1.22 helpers: quitting the other Codex (only processes listed in the warning, re-validated by pid + fingerprint)
  function guardWaitMs(envName, dflt) { var v = Number(env[envName]); return v >= 0 ? v : dflt; }
  function isAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; } }
  /** pid -> command text for every process of this user, or null when ps fails. */
  function psSnapshot() {
    try {
      var args = ['eww', '-o', 'pid=,command='];
      if (typeof process.getuid === 'function') args.push('-U', String(process.getuid()));
      var out = require('child_process').execFileSync('/bin/ps', args, { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 * 1024 });
      var map = {};
      String(out).split('\n').forEach(function (line) { var m = /^\s*(\d+)\s(.*)$/.exec(line); if (m) map[m[1]] = m[2]; });
      return map;
    } catch (e) { return null; }
  }
  /** The same process still: same pid AND same fingerprint (a Codex server's executable + argv, or the stock executable). */
  function stillSame(snapshot, c) {
    var rest = snapshot && snapshot[String(c.pid)];
    if (rest === undefined) return false;
    if (c.kind === 'stock') return rest === STOCK_EXECUTABLE || rest.indexOf(STOCK_EXECUTABLE + ' ') === 0;
    return psCommand(rest) === c.fingerprint;
  }
  function waitGone(pids, ms) {
    var deadline = Date.now() + ms;
    for (;;) {
      var left = pids.filter(isAlive);
      if (!left.length || Date.now() >= deadline) return left;
      sleepMs(100);
    }
  }
  function signal(pid, sig) { try { process.kill(pid, sig); return true; } catch (e) { return false; } }
  function showDialog(opts) { return require('electron').dialog.showMessageBoxSync(opts); }

  /** @returns {{ok:boolean, decision:string, extra:object}} ok = every targeted process is gone and startup may continue */
  function quitOthers(targets) {
    var snap = psSnapshot();
    var valid = targets.filter(function (c) { return stillSame(snap, c); });
    var skipped = targets.filter(function (c) { return valid.indexOf(c) < 0; }).map(function (c) { return c.pid; });
    var pids = valid.map(function (c) { return c.pid; });
    pids.forEach(function (pid) { signal(pid, 'SIGTERM'); });
    var survivors = waitGone(pids, guardWaitMs('CODEX_MODS_GUARD_QUIT_WAIT_MS', 5000));
    if (!survivors.length) return { ok: true, decision: 'quit-others', extra: { pids: pids, skipped: skipped, outcome: 'exited' } };
    var answer;
    try {
      answer = showDialog({
        type: 'warning', buttons: ['Force quit', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
        message: 'The other Codex did not quit.',
        detail: survivors.map(function (pid) { var c = valid.filter(function (x) { return x.pid === pid; })[0]; return (c && c.kind === 'stock' ? 'the stock ChatGPT app' : 'a Codex app-server') + ' (pid ' + pid + ') is still running'; }).join('\n') + '\n\nForce quit stops it immediately; unsaved work in it is lost.',
      });
    } catch (e) { answer = 1; }
    if (answer !== 0) return { ok: false, decision: 'quit-others-cancelled', extra: { pids: pids, skipped: skipped, survivors: survivors } };
    var again = psSnapshot();
    var forced = valid.filter(function (c) { return survivors.indexOf(c.pid) >= 0 && stillSame(again, c); }).map(function (c) { return c.pid; });
    forced.forEach(function (pid) { signal(pid, 'SIGKILL'); });
    var still = waitGone(forced, guardWaitMs('CODEX_MODS_GUARD_FORCE_WAIT_MS', 2000));
    if (still.length) return { ok: false, decision: 'quit-others-failed', extra: { pids: pids, skipped: skipped, forced: forced, survivors: still } };
    return { ok: true, decision: 'quit-others', extra: { pids: pids, skipped: skipped, outcome: 'force-quit', forced: forced } };
  }

  function armGuard(app, check) {
    app.once('ready', function () {
      var decision;
      var extra = {};
      var killable = check.conflicts.filter(function (c) { return c.kind === 'stock' || c.kind === 'cli'; });     // unknown-environment entries cannot be quit
      var trustable = check.conflicts.filter(function (c) { return c.kind === 'cli'; });
      // "Always allow" only when EVERY conflict is an identifiable Codex server: never the stock app, never an unreadable or failed check.
      var canTrust = !check.failed && !check.unknown && check.conflicts.length > 0 && trustable.length === check.conflicts.length;
      var ids = ['continue'].concat(killable.length ? ['quit-others'] : []).concat(['quit']);
      var buttons = ids.map(function (id) { return id === 'continue' ? 'Continue anyway' : id === 'quit-others' ? 'Quit the other Codex' : 'Quit'; });
      var quitIndex = ids.length - 1;
      var ok = true;
      try {
        var idx = showDialog({
          type: 'warning', buttons: buttons, defaultId: quitIndex, cancelId: quitIndex, noLink: true,    // Return and Escape both mean Quit
          message: (check.failed || check.unknown) ? 'Could not fully check for other running Codex apps.' : 'Another Codex app may be using the same data.',
          detail: check.reasons.join('\n') + '\n\nRunning two apps on one Codex home can corrupt conversations. Continue only if you know it is safe.',
        });
        // Only an exact, valid choice acts; Escape (cancelId), Quit and anything unexpected quit.
        var chosen = (typeof idx === 'number' && idx >= 0 && idx < ids.length && Math.floor(idx) === idx) ? ids[idx] : null;
        if (chosen === 'continue') {
          decision = 'continue';
          if (canTrust) {
            var second = 0;
            try {
              second = showDialog({
                type: 'question', buttons: ['Just this time', 'Always allow this server'], defaultId: 0, cancelId: 0, noLink: true,
                message: 'Continue with the other Codex server running?',
                detail: 'Always allow remembers this server (its program and arguments) so it no longer triggers this warning. A different or new server still will.',
              });
            } catch (e) { second = 0; }
            if (second === 1) decision = 'continue-trusted';
          }
        } else if (chosen === 'quit-others') {
          var q = quitOthers(killable);
          decision = q.decision; extra = q.extra; ok = q.ok;
        } else if (chosen === 'quit') {
          decision = 'quit';
        } else {
          decision = 'quit-unexpected-result';
          check.reasons = check.reasons.concat(['the warning dialog returned an unexpected value']);
        }
      } catch (e) { decision = 'quit-dialog-failed'; check.reasons = check.reasons.concat(['the warning dialog could not be shown: ' + String(e && e.message || e).slice(0, 120)]); }
      var fingerprints = uniqueFingerprints(check.conflicts);
      guardLog(Object.assign({ decision: decision, reasons: check.reasons, fingerprints: fingerprints, inspectionFailed: !!check.failed, inspectionUnknown: !!check.unknown }, extra));
      var proceeds = decision === 'continue' || decision === 'continue-trusted' || (decision === 'quit-others' && ok);
      if (!proceeds) {   // never continue unconfirmed: nothing else has started (the framework is held back)
        clearLastContinue();                                           // a Quit forgets what the owner last allowed
        undoThisLaunchsBootState();
        releaseInstanceLock(instanceLock);
        try { app.exit(0); } catch (e) { /* ignored */ }
        // Reliable exit whatever else exists: if the process is still alive shortly after, exit hard.
        var hard = setTimeout(function () { try { process.exit(0); } catch (e) { /* ignored */ } }, 1500);
        if (hard && typeof hard.unref === 'function') hard.unref();
        return;
      }
      if (decision === 'continue-trusted') trustFingerprints(uniqueFingerprints(trustable));
      if (decision !== 'quit-others') writeLastContinue(fingerprints);   // framework-initiated relaunches inherit this (v1.19)
      // Continue: only now does the framework start (Host, views, recovery and its safe-mode dialog).
      if (deferredBegin) {
        var begin = deferredBegin; deferredBegin = null;
        try { begin(); } catch (e) {
          try { writeJson(path.join(L.flags, 'last-loader-error.json'), { at: new Date().toISOString(), stage: 'framework-begin', message: String(e && e.message || e), stack: String(e && e.stack || '') }); } catch (e2) { /* ignored */ }
        }
      }
    });
  }

  var computerUsePath = path.join(profileDir, 'computer-use');   // layout.computerUse
  function computerUseDir() {
    try { mkdirp(computerUsePath); } catch (e) { /* the env var still names it; the helper creates what it needs */ }
    process.env.CODEX_MODS_COMPUTER_USE_DIR = computerUsePath;
  }

  var instanceLock = null;
  try {
    // ---- 0. Instance lock FIRST: a second instance must not touch boot.json, flags or the environment.
    stage = 'instance-lock';
    try { instanceLock = acquireInstanceLock(); } catch (e) { instanceLock = null; }   // an unusable lock must never stop the app
    if (instanceLock && instanceLock.held) {
      try {
        mkdirp(path.join(profileDir, 'logs'));
        fs.appendFileSync(path.join(profileDir, 'logs', 'second-instance.log'),
          JSON.stringify({ t: new Date().toISOString(), msg: 'second instance exits', pid: process.pid, holderPid: instanceLock.owner.pid || null, holderApp: instanceLock.owner.appPath || null, appPath: process.execPath || null }) + '\n', { mode: 0o600 });
      } catch (e) { /* the log is a courtesy */ }
      try { require('electron').app.exit(0); } catch (e) { /* ignored */ }
      if (typeof process.exit === 'function') { try { process.exit(0); } catch (e) { /* ignored */ } }
      return;
    }
    if (instanceLock && typeof process.on === 'function') process.on('exit', function () { releaseInstanceLock(instanceLock); });
    var relaunchIntent = consumeRelaunchIntent();      // one-shot, whatever the profile says

    // ---- The copy must never self-update (every boot: enabled, passthrough, error path): the updater would replace the signed copy.
    process.env.CODEX_SPARKLE_ENABLED = 'false';

    // ---- The copy's own Computer Use helper directory (v1.13), on every boot: the ui pack's cua-relocate-dir transform installs and
    // launches the helper from $CODEX_MODS_COMPUTER_USE_DIR; without it, it would fall back into the Codex home (~/.codex).
    computerUseDir();

    // ---- 1-2. Profile isolation, on every boot including passthrough (contracts/ipc.d.ts 5).
    stage = 'profile-isolation';
    var profile = readJsonOrNull(L.profileConfig);
    var codexHome = profile && typeof profile.codexHome === 'string' && profile.codexHome ? profile.codexHome : L.codexHome;
    process.env.CODEX_HOME = codexHome;
    var app = require('electron').app;
    // Owl ignores setPath('userData') (the builder fixes userData via owl-app.ini); the call is kept because it is harmless
    // on a stock Electron runtime, and a failure of it must not stop the boot.
    try { app.setPath('userData', L.userData); } catch (e) { /* ignored */ }

    // ---- Concurrency guard (warn but allow); also for a disabled framework.
    stage = 'guard';
    var guardArmed = false;
    if (profile && profile.guardStockApp) {
      var trusted = Array.isArray(profile.guardTrusted) ? profile.guardTrusted.filter(function (f) { return typeof f === 'string'; }) : [];
      var guardCheck = detectConcurrency(codexHome, path.join(profileDir, 'run'), trusted);
      if (guardCheck.failed || guardCheck.unknown || guardCheck.reasons.length) {
        var allowed = readLastContinue();
        var inherited = relaunchIntent && !guardCheck.failed && guardCheck.conflicts.length > 0 &&
          guardCheck.conflicts.every(function (c) { return allowed.indexOf(c.fingerprint) >= 0; });
        if (inherited) {
          // A framework-initiated relaunch within 10 minutes whose conflicts the owner already allowed: no second prompt.
          guardLog({ decision: 'inherited', reasons: guardCheck.reasons, fingerprints: uniqueFingerprints(guardCheck.conflicts) });
          writeLastContinue(uniqueFingerprints(guardCheck.conflicts));
        } else { armGuard(app, guardCheck); guardArmed = true; }
      }
    }

    // ---- 3. Rung 5: framework disabled -> passthrough.
    stage = 'flags';
    if (exists(path.join(L.flags, 'disabled'))) return;

    // ---- Backend override (v1.2): the app reads CODEX_CLI_PATH. Only when the framework is enabled; framework-main
    // removes it again if it decides to run unmodded.
    stage = 'cli-override';
    if (process.resourcesPath) {
      process.env.CODEX_CLI_PATH = path.join(path.dirname(process.resourcesPath), 'Resources', 'codexmods-relay');
    }

    // ---- 4. Boot marker and automatic revert (rungs 3-4); independent of framework code.
    stage = 'boot-marker';
    var markerFileRaw = readText(path.join(L.flags, 'boot.json'));       // exactly as before this launch (null: absent)
    var marker = readJsonOrNull(path.join(L.flags, 'boot.json')) || {};
    var unhealthy = marker.state === 'booting' ? (Number(marker.unhealthyCount) || 0) + 1 : 0;
    var generation = typeof marker.generation === 'number' ? marker.generation : 0;
    var relaunching = null;
    var needSafe = false;
    if (unhealthy >= 2) {
      stage = 'auto-revert';
      needSafe = true;      // written only if we stay in THIS bundle: a reopened LKG candidate must not inherit it
      // Framework: point `current` at the LKG version (previous is left alone).
      var lkgVersion = (readText(L.frameworkLkg) || '').trim();
      var currentVersion = (readText(L.frameworkCurrent) || '').trim();
      if (validVersion(lkgVersion) && lkgVersion !== currentVersion && isDir(path.join(L.framework, lkgVersion))) {
        writeAtomic(L.frameworkCurrent, lkgVersion + '\n');
      }
      // App copy: re-point the stable launch symlink at the LKG copy (new link + rename over it).
      var lkgApp = null;
      try {
        lkgApp = fs.lstatSync(L.lkgApp).isSymbolicLink()
          ? path.resolve(path.dirname(L.lkgApp), fs.readlinkSync(L.lkgApp))
          : (readText(L.lkgApp) || '').trim() || null;
      } catch (e) { lkgApp = null; }
      var appPath = profile && typeof profile.appPath === 'string' ? profile.appPath : '';
      if (lkgApp && appPath) {
        var linked = null;
        try { linked = path.resolve(path.dirname(appPath), fs.readlinkSync(appPath)); } catch (e) { linked = null; }
        if (linked !== null && linked !== path.resolve(lkgApp)) {
          var tmpLink = appPath + '.codexmods-' + process.pid + '.tmp';
          try { fs.unlinkSync(tmpLink); } catch (e) { /* none */ }
          fs.symlinkSync(lkgApp, tmpLink);
          fs.renameSync(tmpLink, appPath);
        }
      }
      // Reopen by IDENTITY, whatever the symlink state: if the bundle that is running is not the certified LKG candidate (e.g. a
      // candidate B opened directly while the symlink already points at A), reopen exactly the LKG candidate.
      if (lkgApp) {
        var running = bundleOf(process.execPath);
        if (running && canonical(lkgApp) !== running) relaunching = lkgApp;
      }
    }
    function writeMarker(count, state) {
      writeJson(path.join(L.flags, 'boot.json'), {
        generation: generation, startedAt: new Date().toISOString(), state: state || 'booting', unhealthyCount: count,
        // Crash history belongs to framework-main (writer) and startHost's quarantine step (the only clearer): never dropped here.
        ...(Array.isArray(marker.breadcrumbs) ? { breadcrumbs: marker.breadcrumbs } : {}),
        ...(marker.hostCrashCount !== undefined ? { hostCrashCount: marker.hostCrashCount } : {}),
        ...(marker.lastHostCrashAt !== undefined ? { lastHostCrashAt: marker.lastHostCrashAt } : {}),
      });
    }
    if (relaunching) {
      // Not an untargeted app.relaunch() (it would reopen the bad running copy): open the exact LKG candidate. The reopen counts as
      // done ONLY when /usr/bin/open exits 0; otherwise log it and fall to the next rung (safe mode in this bundle), never loop.
      // The reopened bundle must start exactly the way the failing one did: the profile's launchArgs PLUS the switches this instance was
      // opened with (e.g. QA's --use-mock-keychain; without it the LKG copy hits the real Keychain prompt). Helper-process and debugger
      // switches are not carried over.
      var launchArgs = profile && Array.isArray(profile.launchArgs) ? profile.launchArgs.filter(function (a) { return typeof a === 'string'; }) : [];
      var seenKeys = {};
      launchArgs.forEach(function (a) { seenKeys[a.split('=')[0]] = true; });
      (Array.isArray(process.argv) ? process.argv.slice(1) : []).forEach(function (a) {
        if (typeof a !== 'string' || a.indexOf('--') !== 0 || /^--(inspect|remote-debugging|type=)/.test(a) || seenKeys[a.split('=')[0]]) return;
        seenKeys[a.split('=')[0]] = true; launchArgs.push(a);
      });
      var openArgs = ['-n', relaunching].concat(launchArgs.length ? ['--args'].concat(launchArgs) : []);
      var opened = false, openNote = '';
      try { writeJson(intentFile, { at: new Date().toISOString(), reason: 'lkg-reopen', pid: process.pid }); } catch (e) { /* a courtesy */ }
      try {
        var res = require('child_process').spawnSync('/usr/bin/open', openArgs, { stdio: 'ignore', timeout: 15000 });
        opened = !!res && !res.error && res.status === 0;
        openNote = res && res.error ? String(res.error.message || res.error) : 'status ' + (res ? res.status : 'none');
      } catch (e) { opened = false; openNote = String(e && e.message || e); }
      try {
        mkdirp(path.join(profileDir, 'logs'));
        fs.appendFileSync(path.join(profileDir, 'logs', 'lkg-reopen.log'), JSON.stringify({ t: new Date().toISOString(), target: relaunching, ok: opened, note: openNote }) + '\n', { mode: 0o600 });
      } catch (e) { /* a courtesy */ }
      if (opened) {
        // The streak is consumed: the LKG candidate's first boot must count from zero and must not read this marker as an unfinished
        // boot (state 'booting' would make its loader count one), nor find a safe flag we wrote for the failing bundle.
        writeMarker(0, 'healthy');
        releaseInstanceLock(instanceLock); app.exit(0); return;
      }
      try { fs.unlinkSync(intentFile); } catch (e) { /* none */ }          // nobody is coming to consume it
      // not reopened: keep the counted unhealthy boots and carry on in safe mode (already flagged) in the current bundle
    }
    var safeRawBefore = readText(path.join(L.flags, 'safe'));            // null: absent
    var safeExistedBefore = safeRawBefore !== null || exists(path.join(L.flags, 'safe'));
    if (needSafe) writeJson(path.join(L.flags, 'safe'), { reason: 'unhealthy-boots' });
    writeMarker(unhealthy);
    bootUndo = { markerFile: path.join(L.flags, 'boot.json'), markerRaw: markerFileRaw, safeFile: path.join(L.flags, 'safe'), safeWritten: needSafe, safeRaw: safeExistedBefore ? (safeRawBefore === null ? '' : safeRawBefore) : null };

    // ---- 5. Hand over to framework-main.
    stage = 'framework';
    var version = (readText(L.frameworkCurrent) || '').trim();
    if (!validVersion(version)) throw new Error('framework/current is missing or invalid');
    var safe = exists(path.join(L.flags, 'safe'));
    var fw = require(path.join(L.framework, version, 'framework', 'main', 'index.cjs')).start({ root: root, profile: profileName, safe: safe, deferStart: guardArmed, instanceLock: instanceLock && !instanceLock.held ? { file: instanceLock.file, token: instanceLock.token } : null });
    // A framework that honours deferStart returns { begin }; it runs only after the owner chose Continue (an older one has started already).
    if (guardArmed && fw && typeof fw.begin === 'function') deferredBegin = fw.begin;
  } catch (err) {
    // ---- 6. Never prevent the app from starting: with no framework behind it the relay has nothing to talk to,
    // so the app goes back to its own backend.
    try { delete process.env.CODEX_CLI_PATH; } catch (e) { /* ignore */ }
    try { process.env.CODEX_SPARKLE_ENABLED = 'false'; } catch (e) { /* ignore */ }
    try { computerUseDir(); } catch (e) { /* ignore */ }
    try {
      writeJson(path.join(L.flags, 'last-loader-error.json'), {
        at: new Date().toISOString(), stage: stage,
        message: String(err && err.message || err), stack: String(err && err.stack || ''),
      });
    } catch (e) { /* nothing left to do */ }
  }
})();
