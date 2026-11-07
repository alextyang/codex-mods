# example.contribution

A setting of each chat, given to the agent with every message sent in that chat. Made with `codexmods new` from the SDK's `contribution` starter.

`mod.json` declares the setting, `host.mjs` adds it to each message (an interceptor of `CodexThread.send`), and `renderer.mjs` draws it above the composer. The guide to this starter and the rest of the SDK is [Writing a mod](https://github.com/alextyang/codex-mods/blob/main/docs/AUTHORING.md#the-contribution-starter).

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
