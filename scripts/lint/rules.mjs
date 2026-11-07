// The repository's own lint rules (eslint.config.mjs). Tooling only: nothing that ships inside the app imports this.
//
// no-provider-identity (docs/design/graph-integrity.md G2.1, G2.4): shared surfaces render the concept, so which provider an instance
// comes from never decides what a surface offers. It reports a comparison of a `provider` (a ref's, an instance's, a variable named so)
// with a provider id: a string, a constant naming one, or a `case` of a switch on it. Code that addresses the app's own objects (a Codex
// project, a file of this Mac, the app's own settings) says so where it compares, with a disable comment that names the object.

const EQUALITY = new Set(['===', '!==', '==', '!=']);

const unwrap = (n) => (n?.type === 'ChainExpression' ? n.expression : n);
/** `x.provider`, `x?.provider`, `x['provider']`, or a variable named `provider`. */
function isProvider(n) {
  const x = unwrap(n);
  if (x?.type === 'Identifier') return x.name === 'provider';
  if (x?.type !== 'MemberExpression') return false;
  if (!x.computed) return x.property?.type === 'Identifier' && x.property.name === 'provider';
  return x.property?.type === 'Literal' && x.property.value === 'provider';
}

/** A provider id: a string, a template without expressions, or a const initialized with one. */
function providerId(n, scopeOf) {
  if (n?.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n?.type === 'TemplateLiteral' && n.expressions.length === 0) return n.quasis[0]?.value?.cooked ?? '';
  if (n?.type !== 'Identifier') return null;
  for (let scope = scopeOf(n); scope; scope = scope.upper) {
    const v = scope.set.get(n.name);
    if (!v) continue;
    const def = v.defs[0];
    if (def?.type === 'Variable' && def.parent?.kind === 'const' && def.node.init) return providerId(def.node.init, () => null);
    return null;
  }
  return null;
}

export const noProviderIdentity = {
  meta: {
    type: 'problem',
    docs: { description: 'Shared surfaces render the concept: no decisions on which provider an instance comes from (graph-integrity G2.4)' },
    schema: [],
    messages: {
      identity: 'compares a provider with "{{id}}": shared surfaces decide by the concept, its relations and what the instance supports (`can`). Code that addresses the app\'s own objects names the object in a disable comment.',
    },
  },
  create(context) {
    const scopeOf = (node) => context.sourceCode.getScope(node);
    const report = (node, id) => context.report({ node, messageId: 'identity', data: { id } });
    return {
      BinaryExpression(node) {
        if (!EQUALITY.has(node.operator)) return;
        for (const [a, b] of [[node.left, node.right], [node.right, node.left]]) {
          if (!isProvider(a)) continue;
          const id = providerId(b, scopeOf);
          if (id !== null) { report(node, id); return; }
        }
      },
      SwitchStatement(node) {
        if (!isProvider(node.discriminant)) return;
        for (const c of node.cases) {
          const id = c.test ? providerId(c.test, scopeOf) : null;
          if (id !== null) report(c, id);
        }
      },
    };
  },
};

export default { meta: { name: 'codexmods' }, rules: { 'no-provider-identity': noProviderIdentity } };
