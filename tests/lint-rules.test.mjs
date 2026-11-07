// The repository's own lint rules (scripts/lint/rules.mjs), through ESLint's RuleTester under node:test.
import { describe, it } from 'node:test';
import { RuleTester } from 'eslint';
import { noProviderIdentity } from '../scripts/lint/rules.mjs';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;
const tester = new RuleTester({ languageOptions: { ecmaVersion: 2025, sourceType: 'module' } });

tester.run('no-provider-identity', noProviderIdentity, {
  valid: [
    // a type check, a comparison of two instances' providers, a provider compared with something that is not an id
    'const ok = typeof ref.provider === "string";',
    'const same = a.provider === b.provider;',
    'const mine = ref.provider === modId;',
    'const n = list.filter((x) => x.kind === "codex");',
    'switch (ref.type) { case "Thread": break; }',
  ],
  invalid: [
    { code: 'if (ref.provider === "codex") draw();', errors: [{ messageId: 'identity', data: { id: 'codex' } }] },
    { code: 'const off = thread?.provider !== "codex";', errors: [{ messageId: 'identity' }] },
    { code: 'const yes = "codex" == x.ref.provider;', errors: [{ messageId: 'identity' }] },
    { code: 'const yes = x["provider"] === `codex`;', errors: [{ messageId: 'identity' }] },
    { code: 'const P = "codex"; const f = (r) => r.provider === P;', errors: [{ messageId: 'identity', data: { id: 'codex' } }] },
    { code: 'function f(provider) { return provider === "qa.test-agent"; }', errors: [{ messageId: 'identity', data: { id: 'qa.test-agent' } }] },
    { code: 'switch (ref.provider) { case "codex": a(); break; default: b(); }', errors: [{ messageId: 'identity' }] },
  ],
});
