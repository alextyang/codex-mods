// A composer document's text as the framework says it (docs/design/graph-layers.md §3.2): its paragraphs joined by newlines, a hard
// break a newline, a link its text, a mention `@label` (a chip named by a title: `@title`). The Host reads it from the app's saved drafts and the page from the live editor, so a draft's guard
// compares the same thing. Node built-ins only; no imports.

/** The text of a ProseMirror document as JSON (`{type: 'doc', content}`); '' for none. */
export function textOfDoc(doc) {
  const paragraphs = [];
  function visit(node) {
    if (node?.type === 'paragraph') {
      paragraphs.push((Array.isArray(node.content) ? node.content : []).map((n) => n?.type === 'text' ? n.text ?? ''
        : n?.type === 'hard_break' ? '\n' : n?.type === 'richLink' ? String(n.attrs?.displayText ?? n.attrs?.href ?? '')
          : `@${n?.attrs?.label ?? n?.attrs?.name ?? n?.attrs?.title ?? n?.attrs?.path ?? ''}`).join(''));
    } else for (const child of Array.isArray(node?.content) ? node.content : []) visit(child);
  }
  visit(doc);
  return paragraphs.join('\n');
}
