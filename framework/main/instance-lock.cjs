'use strict';
// Release side of the per-profile instance lock the loader takes (loader/loader.cjs, v1.8). Only the lock this process created
// (matching token) is ever removed; anything else is left alone.
const fs = require('node:fs');

function releaseInstanceLock(lock) {
  if (!lock || !lock.file) return false;
  try {
    const owner = JSON.parse(fs.readFileSync(lock.file, 'utf8'));
    if (owner && owner.token === lock.token) { fs.unlinkSync(lock.file); return true; }
  } catch { /* already gone or not ours */ }
  return false;
}

module.exports = { releaseInstanceLock };
