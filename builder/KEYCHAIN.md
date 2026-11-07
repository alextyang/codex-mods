# Keychain item name and prompts in the Owl framework: static analysis (ChatGPT 26.1007.30912 / 20156)

Method: static only. `strings -t d`, `otool -l`, `llvm-objdump -d` (Xcode) and small scanners in `builder/tools/static-analysis/` over
`/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/155.0.8059.40/Codex Framework` (read-only, arm64, no
symbols). No app was launched and no Keychain command was run for this report. Addresses are vmaddrs; in `__TEXT` they equal file offsets.
Function names below are mine (the binary is stripped; llvm-objdump prints misleading nearest-exported-symbol names, ignore those).

## 0. Answer in short

| Question | Answer |
|---|---|
| Where does `<name>` come from? | A **hard-coded constant** `Codex`, built from instruction immediates. Not Info.plist, not owl-app.ini, not env. The service is `"Codex" + " Storage Key"` = **`Codex Storage Key`**, the account is **`Codex`**. That is why `productName` did not change it. |
| Is `--use-mock-keychain` consulted? | **Yes**, on exactly this path, as a **command-line switch** (`base::CommandLine::HasSwitch("use-mock-keychain")`). With it, the key getter uses an in-memory keychain object whose reachable code calls no `Sec*` function. No owl-app.ini key or env var can set it (the ini only carries `UserDataDirectoryName` and `AppVersion` in this build; there is no other keychain-related string in the binary). |
| Why would a relaunch of the same approved copy prompt again? | Not decidable statically. The code excludes one candidate (re-creating the item every launch); what is left is ACL/partition-list behaviour for ad-hoc code in securityd. Ranked hypotheses and the metadata-only checks that separate them are in section 3. |
| A launch that cannot prompt? | `--use-mock-keychain` (section 4). It covers the OSCrypt "Storage Key" lookup. Other Security-framework call sites exist in the binary and are not proven unreachable at startup (section 4). |

## 1. Where `<name>` comes from (evidence chain)

1. `strings` finds `use-mock-keychain` at 226544377 and, directly after it, one C string `saltysalt Storage Key` at 226544395
   (`" Storage Key"` is its tail, tail-merged by the linker; `"saltysalt"` is a prefix used with an explicit length).
2. ADRP/ADD cross-references (`adrp-xref.py`) to those addresses give exactly four code sites, all in one function F at `0x1049f4c`
   (call it `OsCryptGetKey`):
   - `0x1049f84`: `use-mock-keychain`
   - `0x104a078`: `saltysalt` (len 9) with iterations `0x3eb` = 1003 and key length 16, i.e. Chromium's OSCrypt PBKDF2-HMAC-SHA1
     key derivation (`v10` prefix, `saltysalt` salt; PBKDF2 helper at `0x104a434`)
   - `0x104b954`: `" Storage Key"` (len `0xc`) in the helper `GetPassword` at `0x104b038`
3. In `GetPassword` the service string is built into a function-local static (`0x10058e38`) at `0x104b940..0x104b964`:
   ```
   104b940: mov  w8, #0x6f43         ; 'C','o'
   104b944: movk w8, #0x6564, lsl 16 ; 'd','e'
   104b948: str  w8, [sp,#0x30]
   104b94c: mov  w8, #0x78            ; 'x'
   104b950: strh w8, [sp,#0x34]       ; string "Codex" (length 5 set at 104b928)
   104b954: adrp x1,0xd80c000 ; add x1,x1,#0xb14   ; " Storage Key"
   104b960: mov  w2,#0xc ; bl append                 ; -> "Codex Storage Key"
   ```
   The account is a second static (`0x10058e58`) set at `0x104b0d0..0x104b0e0` with the same immediates: **`Codex`**.
   Neither reads a bundle key: no call into CFBundle/NSBundle/ini parsing occurs between function entry and these stores.
4. The lookup is `keychain->FindGenericPassword(service="Codex Storage Key", account="Codex")` (virtual slot 11, `blr` at `0x104b164`).
5. Fallbacks in the same function, in order:
   1. if the first lookup fails, a second lookup of `"Aura Safe Storage"` / account `"Aura"` (statics at `0x10058e78`, `0x10058e98`; the
      bytes at `0xe26f44c` read `Aura Safe Storage`). A not-found lookup raises no prompt; if such an item existed it would be an access to
      another application's item.
   2. the key is created **only** if the status is `errSecItemNotFound` (`cmp w21, #-25300` at `0x104b480`, then `0x104b67c`): 16 random
      bytes stored with `AddGenericPassword` (slot 10) under the same service and account. Any other status (user cancelled, auth failed,
      `errSecInteractionNotAllowed`, `errSecMissingEntitlement` -34018) is logged and returned as an error; it does not create a new item.
6. Cross-check: the only other `"Codex"` materialisations with the same two instructions are at `0x6a14964` and `0xcf32bc0` (unrelated
   strings). The names `Chrome Safe Storage`, `ChatGPT Safe Storage`, `Aura Safe Storage` at 237433883.. belong to the browser-data importer
   (Rust `user_data_importer`), which reads other browsers' items through the legacy `SecKeychainFindGenericPassword` (callers at
   `0x80a2efc`, `0x80a2f64`); a prompt that names one of those items comes from the importer, not from the Storage Key.

Consequence: the service/account of the Owl OSCrypt key are fixed by the binary: **`Codex Storage Key` / `Codex`**, shared with the stock app
(same constants), so a mod copy and the stock app contend for one login-keychain item. Changing them needs a binary patch (section 5).

## 2. `--use-mock-keychain`

- `0x1049f78..0x1049f90`: `x1 != 0` means a caller supplied a keychain object (tests): used as is. Otherwise
  `x0 = CommandLine::ForCurrentProcess()` (global at `0x1021d068`) and `CommandLine::HasSwitch("use-mock-keychain")` (`0x55ad58`).
  - true: `new` a 64-byte object, constructor at `0x104a220` (vtable `0xf51d1f8`, access group string `test-access-group`), used instead of
    the real keychain; `0x104a148` (switch absent) takes `x21 = 0x25aba20()` = the real singleton (vtable `0xf5549c0`).
- The real singleton is a thin vtable over Security.framework (`vtable-sec-calls.py`): slot 6 `SecItemAdd`+`SecItemCopyMatching`, slot 7
  `SecItemCopyMatching`, slot 8 `SecItemDelete`, slot 9 `SecItemUpdate`/`SecItemDelete`, slots 1..5 `SecKey*`. `FindGenericPassword` (slot 11,
  `0x499f680`) builds a `{class: genericpassword, service, account, limit: one, return data}` dictionary and calls slot 7. An entitlement gate
  (`0x499f8f0` -> `0x25ab8fc`, access group `2DC432GLL2.com.openai.shared`) decides whether `kSecUseDataProtectionKeychain` and
  `kSecAttrAccessGroup` are added. The copy has `keychain-access-groups` stripped by the builder, so the query goes to the **file-based
  login keychain**, the one with per-item ACLs and "Always Allow" prompts.
- The mock object's vtable (slots 5..13 at `0x8c69660..0x8c6a0d8`, FindGenericPassword `0x3a733d0`) reaches only `CFDictionary`,
  `CFArray`, `CFEqual`, `CFRetain`, `CFRelease`, `pthread_mutex_unlock`, `memset_pattern16` (direct-call closure to depth 5). No `SecItem*`,
  `SecKeychain*`, `SecAccess*` or `LAContext`. (Slots 0..4 and 14 contain `SecKey*` stubs; they are the SecKey operations of the shared
  interface, not on the password path.) The constructor performs no Security call either.
- Mechanism: **command-line switch only.** `open -n <app> --args --user-data-dir=... --use-mock-keychain` puts it on the process command
  line (the same path that carries `--user-data-dir`). owl-app.ini: the file in this build has only `[Owl] UserDataDirectoryName` and
  `AppVersion`; Owl injects `--user-data-dir` into the in-process command line from it (observed natively earlier), but there is no string
  for any keychain or generic-switches key, so an ini route is not available. No environment variable name relating to the keychain exists in
  the binary.
- Mock side effects (QA only): the derived key is constant, so cookies/encrypted values written with the mock are unreadable by a launch
  without the switch. Use it only for QA roots.

## 3. Why a relaunch of an identical-cdhash copy can prompt again

What the code rules out:
- *The item is re-created each launch.* No: creation happens only on `errSecItemNotFound` (section 1.5), and only then.
- *A clone of the app under a temp dir (a different path each run).* Chromium's `CodeSignCloneManager` strings are present
  (`kMacAppCodeSignClone`, `code_sign_clone`), but every earlier native run's process listing shows the main executable and helpers running
  from the copy's own path under `apps/`, not from a temp clone.
- *The framework asks for the wrong thing every time.* The query is the same single `SecItemCopyMatching`; the Aura fallback only runs after
  a failure.

What securityd semantics leave (cannot be separated without touching the Keychain; ordered by my confidence):
1. **ACL grant vs. partition list for ad-hoc code.** A file-keychain item has a per-authorization ACL (trusted applications) and, since
   macOS 10.12, a partition-ID entry. A caller must satisfy both; "Always Allow" is supposed to add the caller to the trusted list and its
   partition ID to the list (this needs the user's login password in the dialog). An ad-hoc, team-less caller has no `teamid:` partition; the
   only possible id is a `cdhash:` one. If the dialog's "Always Allow" was answered with "Allow" (no password) or the partition update is not
   persisted for a team-less caller, every launch is a fresh decision. This fits "same cdhash, prompts every time".
2. **The grant went to a different code identity than the one that asks.** The ACL entry is a code requirement (for ad-hoc code
   `cdhash H"..."`). If the requester at launch N+1 is not byte-identical in cdhash (any change to the copy's sealed contents, including
   `Info.plist`, `owl-app.ini`, `codexmods-adapter.json`, a rebuild or a re-sign, changes the main executable's cdhash because those are
   special slots), the old grant no longer matches. A rebuild always changes it.
3. **The item is owned by another creator** (the stock app, team `2DC432GLL2`, partition `teamid:2DC432GLL2`). The copy is a different team
   (or ad-hoc), so it always needs a partition decision, and by 1 an ad-hoc caller may never be able to persist one.
4. **The dialog is answered for a different item** than the one that keeps asking (for example `Aura Safe Storage` or one of the importer's
   items if those exist in the login keychain).

Metadata-only checks that separate them later (do not read secrets; they still talk to securityd and, with a locked keychain, can prompt):
- `security find-generic-password -s 'Codex Storage Key' -a Codex` (no `-w`, no `-g`): prints attributes only (creation and modification
  dates `cdat`/`mdat`, keychain path). A `cdat` newer than the first launch means the item was re-created (hypothesis excluded above).
- `security dump-keychain -a ~/Library/Keychains/login.keychain-db` (no `-d`): lists items with their ACL entries (trusted-application
  descriptors and the partition-ID entry). It shows whether the partition list contains `cdhash:`/`teamid:` entries and which requirement the
  trusted-application entry holds. Needs explicit approval; this is a read of metadata, not of data.

## 4. A launch that cannot prompt

Recommended (QA): add `--use-mock-keychain` to the launch arguments. Static basis: sections 1 and 2. **Not verified natively.**
`scripts/qa` now appends it (`buildOpenArgs`) and the isolation check requires it on the main process command line (`ps eww`), so a QA launch
without it is a violation.

Caveats the static analysis cannot close:
- Other Security call sites exist: `SecItemCopyMatching` at `0x9614b40` and `0x9616ac8`, the legacy `SecKeychain*`/`SecAccess*` importer
  (`0x80a2efc..0x80a3778`), `SecKey*`, `LAContext` (passkeys / "GPM PIN data wrapping key", device-trust). They are feature-specific and
  I did not prove them unreachable at startup. The importer reads other browsers' items and needs user action; the data-protection keychain
  (access-group path) does not use ACL prompts.
- Isolated alternative with no switch dependence: a dedicated throw-away keychain for the QA macOS user (`security create-keychain -p '' ...`,
  made default and the only entry of the user search list, kept unlocked). A lookup finds nothing, the copy creates the item and is trusted as
  creator; no foreign ACL exists, so no prompt. This changes the QA user's keychain configuration, so it is a second choice.
- Nothing else found: no environment variable, owl-app.ini key or Info.plist key controls keychain use.

## 5. Recommendations

QA profiles (no prompt ever): always launch with `--use-mock-keychain` (done in `scripts/qa`; the product launcher can pass it through the
QA profile's `launchArgs`). Do not rely on "Always Allow" in QA.

Daily profile (at most one prompt, surviving rebuilds):
1. Sign the copy with a **stable team identity** (Apple Development) instead of ad-hoc. The ACL trusted-application entry then holds the
   designated requirement (`identifier ... and certificate leaf[subject.OU] = <TEAM>`), which does not change across rebuilds, and the
   partition ID is `teamid:<TEAM>`; one "Always Allow" (with the login password) then carries over to every rebuild and relaunch. With ad-hoc
   signing every rebuild changes the cdhash (hypothesis 2) and hypothesis 1 may prevent persistence even without a rebuild.
2. Do not share the item with the stock app: the stock app's item is `teamid:2DC432GLL2`, so the copy always needs one extra decision. The
   service/account are constants, so avoiding the collision means a **builder binary patch**: the two `movz w8, #0x78` words (`'x'`) at file
   offsets **`0x104b0dc`** (account) and **`0x104b94c`** (service base) are the only places that differ; each is the 32-bit word
   `0x52800f08`. Changing both to the same other character yields e.g. `Codey Storage Key` / `Codey`. Same style and guard as the asar digest
   patch (verify the 8-byte prefix `68e88d52 88acac72` (`movz`/`movk` of `Code`) at `0x104b0d0` and `0x104b940` and the word `080f8052` at the two offsets above; refuse on any mismatch), then the
   builder's normal re-sign. Hard stops: only valid for this framework build (check the framework file hash first); a longer name would
   need more than a one-word edit (the length stores at `0x104b928` / `0x104b0bc` and the character stores change).
3. Avoid unnecessary rebuilds of the daily copy (each ad-hoc rebuild is a new identity); update by the existing app-switch flow only when
   the stock build or the framework really changes.

Open items I could not settle statically: the exact partition-ID behaviour for team-less callers (section 3, hypotheses 1/3), the
condition under which `0x25ab8fc` enables the access-group path, and whether any other Security call is reachable during sign-in.

## Tools

`builder/tools/static-analysis/`: `adrp-xref.py <vmaddr>=<label> ...` (ADRP+ADD cross-references into `__text`), `bl-xref.py` (callers of
stubs), `vtable-sec-calls.py <dir> <vtable-vmaddr>` (per-slot `Sec*` closure; needs `<dir>/stubs.txt` from
`llvm-objdump --macho --indirect-symbols`). Paths are hard-coded to the build analysed here.
