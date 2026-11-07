# example.rule

A presentation rule: a badge on the app's chats, wherever the app shows them. Made with `codexmods new` from the SDK's `rule` starter.

`renderer.mjs` declares the rule (`ctx.ui.decorate('Thread', ...)`). The guide to this starter and the rest of the SDK is [Writing a mod](https://github.com/alextyang/codex-mods/blob/main/docs/AUTHORING.md#the-rule-starter).

## Try it

```bash
node --test                                   # its test, with the SDK's testing kit
node <checkout>/cli/codexmods.mjs dev .       # into your modded copy as a development package, reloaded as you edit
```

## Ship it

```bash
node <checkout>/cli/codexmods.mjs keygen --out publisher.pem   # once; keep it private
node <checkout>/cli/codexmods.mjs pack . --key publisher.pem   # a signed .codexmod to share
```

`<checkout>` is your Codex Mods checkout. [Package and install](https://github.com/alextyang/codex-mods/blob/main/docs/AUTHORING.md#package-and-install) says how users install it.
