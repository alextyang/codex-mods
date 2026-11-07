# Security policy

## Reporting a vulnerability

Please report security issues privately, not in a public issue or pull request.

Report it through GitHub's private vulnerability reporting for this repository: [Report a vulnerability](https://github.com/alextyang/codex-mods/security/advisories/new) (the repository's Security tab).

Include what you found, the build of the app and the framework version, and steps to reproduce. You will get an acknowledgement, and we will work with you on a fix and on when to disclose it. Please give us a reasonable time to fix an issue before publishing details.

## What this project protects

- The stock ChatGPT app is never modified. The builder makes a separate, uniformly signed copy.
- The modded copy has its own Keychain item, updater and Computer Use helper, isolated from the stock app's.
- Updates are staged and verified, and failures fall back to last-known-good, safe mode or the unmodified app.

Reports about any of these boundaries, such as a path that modifies the stock app, leaks or prompts for the stock app's Keychain item, or runs unverified code during an update, are in scope.

## Mods are trusted code

A mod is not sandboxed. Its Host side runs as ordinary Node code with the permissions of your user account, and its renderer side runs inside the app's own page. Installing a mod means trusting its author as you would any program you run.

The framework limits what a mod can do through declared grants, signature checks and review at install time. Grants are a safeguard against mistakes and a statement of intent, not a security boundary against a malicious mod. Only install mods from authors you trust, and review the grants a mod asks for.

A report that a malicious mod can do something its grants did not list is useful and welcome. A report that an installed, trusted mod can read your files or use the network is expected behavior.

## Supported versions

Only the latest release and the current `main` branch receive security fixes.
