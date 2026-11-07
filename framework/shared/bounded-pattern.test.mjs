// The bounded matcher (review 4, round 2): what JavaScript's engine says, in time linear in the text whatever the pattern.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePattern, MAX_STATES } from './bounded-pattern.mjs';

const PATTERNS = [['^#\\d+$', ''], ['^[A-Z]+-\\d+$', ''], ['^https?://\\S+$', ''], ['^v\\d+\\.\\d+\\.\\d+$', ''], ['foo|bar', ''], ['^(?:ab|cd)+$', ''], ['\\bword\\b', 'i'],
  ['^a.c$', 's'], ['^a.c$', ''], ['^line$', 'm'], ['[^a-c]x', ''], ['[a-c]X', 'i'], ['(a|ab)(c|bcd)(d*)', ''], ['x{2,3}y', ''], ['x{2}', ''], ['x{2,}', ''], ['a{,3}', ''],
  ['\\u0041', 'u'], ['\\u{1F600}', 'u'], ['^.$', 'u'], ['^.$', ''], ['[\\d.]+', ''], ['\\x41b', ''], ['[\\]x]', ''], ['a\\/b', ''], ['(?<n>ab)+c', ''], ['\\B', ''], ['^$', ''],
  ['\\cJ', ''], ['[\\b]', ''], ['a{', ''], ['}', ''], ['^\\s*$', ''], ['[A-Z_a-z]\\w*\\(\\)', ''], ['a+?b', ''], ['(a*)*b', ''], ['[^]', ''], ['[]', '']];
const TEXTS = ['', '#12', '#12a', 'ABC-123', 'abc-123', 'https://x.y/z', 'http://', 'v1.2.3', 'v1.2', 'foo', 'xbar', 'ababcd', 'abcx', 'a word here', 'Word', 'abc', 'a\nc',
  'line\nnext', 'dx', 'ex', 'aX', 'abcd', 'xxy', 'xxxxy', 'xx', 'A', '😀', 'é', '12.5', 'Ab', ']x', 'a/b', 'ababc', 'b', ' ', '\n', '\b', 'a{', '}', '   ', 'foo_bar()', 'Foo()', 'aab'];

test('it says what the engine says, for the syntax it takes', () => {
  for (const [source, flags] of PATTERNS) {
    const native = new RegExp(source, flags), bounded = compilePattern(source, flags);
    for (const text of TEXTS) assert.equal(bounded.test(text), native.test(text), `/${source}/${flags} on ${JSON.stringify(text)}`);
  }
});

test('what needs backtracking, or makes too large an automaton, or is not JavaScript, is refused with its reason', () => {
  for (const [source, flags, why] of [['(?=a)', '', /lookaround/], ['(?<=a)b', '', /lookaround/], ['(a)\\1', '', /back-reference/], ['\\p{L}', 'u', /\\p/], ['a{1001}', '', /at most 1000/],
    ['(a{1000}){1000}', '', new RegExp(`at most ${MAX_STATES}`)], ['(', '', /./], ['a', 'g', /flags/]]) assert.throws(() => compilePattern(source, flags), why, source);
});

test('the shapes that backtrack in the engine take linear time here', () => {
  const text = `${'a'.repeat(2048)}!`;
  for (const source of ['^(a+){20}$', '^(a|aa)+$', `^${'(a|a)'.repeat(30)}!$`, 'a*a*a*a*a*a*a*a*b', '(a*)*b', '^(\\w+\\s?)*$']) {
    const t0 = performance.now();
    assert.equal(compilePattern(source).test(text), false, source);
    assert.ok(performance.now() - t0 < 200, `${source}: ${performance.now() - t0} ms`);
  }
});
