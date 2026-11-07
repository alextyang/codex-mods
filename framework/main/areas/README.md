framework-main's feature-area modules (breadth.md D5, D10): every `<name>.cjs` here is loaded after the fixed modules (index.cjs) and
registers its area with `hooks.onAreaOp("<name>", fn)`, the name of the provider area it serves (graph/providers/codex/areas/<name>.mjs).
Shared pieces: ../area-kit.cjs.
