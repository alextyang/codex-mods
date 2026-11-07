#!/bin/sh
# Swap helper (ARCHITECTURE 12.3). The only out-of-process restart code in the system.
#
#   swap-helper.sh <appPid> <stableSymlink> <candidatePath> <receiptPath> [launchArg...]
#
# Waits for the app to exit (on timeout: receipt only, nothing is reopened), atomically re-points the stable launch symlink at the candidate, writes a receipt,
# reopens the app with `open -n <stable> --args <launchArg...>` (ProfileConfig.launchArgs, so a QA profile keeps its isolation on every
# reopen, including the rollback reopen). It is the only reopen owner for an app-switch. An app bundle is never moved: only symlinks are renamed.
#
# Receipt (JSON, written atomically; never deleted):
#   {"state":"swapping","previous":...,"candidate":...,"at":...}   written before the swap
#   {"ok":true,"previous":...,"candidate":...,"at":...}            the new app was opened
#   {"ok":false,"error":...,"previous":...,"candidate":...,"at":...} nothing changed, or the symlink was put back
#   {"ok":false,"rollbackFailed":true,...}                           opening failed AND the previous symlink could not be restored:
#                                                                    the candidate may still be selected (reconcile inspects the link)
#
# Test hooks (environment): CODEXMODS_SWAP_OPEN (default /usr/bin/open), CODEXMODS_SWAP_PERL (default /usr/bin/perl),
# CODEXMODS_SWAP_WAIT_SECS (default 30).
umask 077
PATH=/usr/bin:/bin:/usr/sbin:/sbin

pid=$1
stable=$2
candidate=$3
receipt=$4
open_cmd=${CODEXMODS_SWAP_OPEN:-/usr/bin/open}
perl_cmd=${CODEXMODS_SWAP_PERL:-/usr/bin/perl}
wait_secs=${CODEXMODS_SWAP_WAIT_SECS:-30}

if [ $# -lt 4 ] || [ -z "$pid" ] || [ -z "$stable" ] || [ -z "$candidate" ] || [ -z "$receipt" ]; then
  echo "usage: swap-helper.sh <appPid> <stableSymlink> <candidatePath> <receiptPath> [launchArg...]" >&2
  exit 64
fi
shift 4   # what remains is the profile's launchArgs, passed to every reopen

# reopen: a new instance of the stable path with the profile's launch arguments (never a bare `open <path>`).
reopen() {
  if [ $# -eq 0 ]; then "$open_cmd" -n "$stable" >/dev/null 2>&1; else "$open_cmd" -n "$stable" --args "$@" >/dev/null 2>&1; fi
}

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n\t' '  '; }
stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# write_receipt <json body without the outer braces>: temp file, fsync, rename (atomic and durable).
write_receipt() {
  tmp="$receipt.tmp.$$"
  body="{$1}"
  "$perl_cmd" -e 'use IO::Handle; open(my $f, ">", $ARGV[0]) or die "open: $!"; print $f $ARGV[1], "\n"; $f->flush; $f->sync; close($f) or die "close: $!"; rename($ARGV[0], $ARGV[2]) or die "rename: $!";' \
    "$tmp" "$body" "$receipt" || { rm -f "$tmp"; echo "swap-helper: cannot write receipt" >&2; return 1; }
}

# repoint <target>: new symlink beside the stable one, renamed over it atomically. The stable path is never removed first.
repoint() {
  link="$(dirname "$stable")/.$(basename "$stable").swap.$$"
  rm -f "$link"
  ln -s "$1" "$link" || return 1
  "$perl_cmd" -e 'rename($ARGV[0], $ARGV[1]) or die $!' "$link" "$stable" || { rm -f "$link"; return 1; }
}

previous=
fail() { # fail <message> [extra json fields, leading comma]
  write_receipt "\"ok\":false$2,\"error\":\"$(json_escape "$1")\",\"previous\":\"$(json_escape "$previous")\",\"candidate\":\"$(json_escape "$candidate")\",\"at\":\"$(stamp)\""
}

# 1. wait for the app to exit
i=0
limit=$((wait_secs * 5))
while kill -0 "$pid" 2>/dev/null; do
  if [ "$i" -ge "$limit" ]; then
    # The original instance is still running: record the failure and launch nothing (a reopen would start a competing instance).
    previous=$(readlink "$stable" 2>/dev/null)
    fail "app did not exit"
    exit 1
  fi
  i=$((i + 1))
  sleep 0.2
done

# Preconditions: the stable path must be a symlink (never clobber a real bundle) and the candidate must exist.
if [ ! -L "$stable" ]; then
  fail "stable path is not a symlink"
  exit 1
fi
previous=$(readlink "$stable")
if [ ! -d "$candidate" ]; then
  fail "candidate does not exist"
  reopen "$@"
  exit 1
fi

# 2. receipt: swapping
write_receipt "\"state\":\"swapping\",\"previous\":\"$(json_escape "$previous")\",\"candidate\":\"$(json_escape "$candidate")\",\"at\":\"$(stamp)\"" || exit 1

# 3. atomic replacement
if ! repoint "$candidate"; then
  fail "could not replace the symlink"
  reopen "$@"
  exit 1
fi

# 4. reopen; on failure put the previous target back the same atomic way
if ! reopen "$@"; then
  err="open failed"
  extra=
  if repoint "$previous"; then err="$err; symlink restored to previous"; else err="$err; could not restore the symlink"; extra=',"rollbackFailed":true'; fi
  reopen "$@"
  fail "$err" "$extra"
  exit 1
fi
write_receipt "\"ok\":true,\"previous\":\"$(json_escape "$previous")\",\"candidate\":\"$(json_escape "$candidate")\",\"at\":\"$(stamp)\""
exit 0
