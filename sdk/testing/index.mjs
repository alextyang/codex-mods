// @codexmods/sdk/testing — fakes for mod tests (ARCHITECTURE §8). Node built-ins only.
export { createFakeHostContext, rpcRequest, rpcNotification, rpcResponse, rpcError } from './host-context.mjs';
export { createFakeRendererContext } from './renderer-context.mjs';
export { createTestGraph, waitFor, USER, APP } from './graph.mjs';
export { replay } from './replay.mjs';
export { createFakeReact } from './fake-react.mjs';
export { LENT_FIXTURES } from './lent-fixtures.mjs';
export { CodexModsError } from '../errors.mjs';
