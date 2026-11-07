// The lent parts' stylesheet (graph-integrity G2.3), as the kit's is: every colour, font and radius one of the app's own variables, the
// column the app's own thread width, and what is left geometry in its spacing unit. The theme owns how all of it looks. NO NODE API.

const u = (n) => `calc(var(--spacing) * ${n})`;

export const LENT_STYLE_ID = 'codexmods-lent-style';
export const LENT_CSS = `
.cml-transcript{flex:1;min-height:0;overflow-y:auto;color:var(--color-text)}
.cml-column{display:flex;flex-direction:column;gap:${u(4)};margin-inline:auto;max-width:var(--thread-content-max-width);padding:${u(4)}}
.cml-turn{display:flex;flex-direction:column;gap:${u(3)}}
.cml-working{display:flex;align-items:center;gap:${u(1.5)};font-size:var(--text-sm);color:var(--color-text-secondary)}
.cml-message{font-size:var(--text-base);line-height:1.6;overflow-wrap:anywhere}
.cml-message p{margin:0 0 ${u(2)}}
.cml-message ul{margin:0 0 ${u(2)};padding-inline-start:${u(5)}}
.cml-message[data-role=user]{display:flex;justify-content:flex-end}
.cml-bubble{max-width:80%;white-space:pre-wrap;border-radius:var(--radius-2xl);padding:${u(2)} ${u(3.5)};background:var(--color-background-secondary-soft-alpha)}
.cml-heading{font-weight:600}
.cml-code{font-family:var(--font-mono);font-size:var(--text-sm);border-radius:var(--radius-lg);padding-inline:${u(1)};background:var(--color-background-secondary-soft-alpha)}
.cml-pre{margin:0;overflow-x:auto;white-space:pre;font-family:var(--font-mono);font-size:var(--text-sm);border-radius:var(--radius-xl);padding:${u(3)};background:var(--color-background-secondary-soft-alpha)}
.cml-step{display:flex;flex-direction:column;gap:${u(1.5)}}
.cml-step-head{display:flex;align-items:center;gap:${u(2)};border:0;padding:0;background:transparent;color:var(--color-text-secondary);font:inherit;font-size:var(--text-sm);text-align:start;cursor:pointer}
.cml-step-head:disabled{cursor:default}
.cml-step-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cml-step-failed{color:var(--color-text-danger)}
.cml-step-body{display:flex;flex-direction:column;gap:${u(2)};padding-inline-start:${u(5.5)}}
.cml-step-detail{font-size:var(--text-sm);color:var(--color-text-secondary)}
.cml-diff{display:flex;flex-direction:column;gap:${u(2)}}
.cml-diff-lines{margin:0;overflow-x:auto;font-family:var(--font-mono);font-size:var(--text-sm);border:1px solid var(--color-border);border-radius:var(--radius-xl)}
.cml-diff-line{display:block;padding-inline:${u(3)}}
.cml-diff-line[data-change=add]{background:var(--color-background-success-surface);color:var(--color-text-success)}
.cml-diff-line[data-change=remove]{background:var(--color-background-danger-soft-alpha);color:var(--color-text-danger)}
.cml-diff-line[data-change=hunk]{color:var(--color-text-tertiary)}
.cml-chip{display:inline-flex;align-items:center;gap:${u(1)};max-width:${u(60)};overflow:hidden;white-space:nowrap;border:1px solid var(--color-border);border-radius:var(--radius-full);padding:${u(0.5)} ${u(2)};background:transparent;color:var(--color-text);font:inherit;font-size:var(--text-xs)}
button.cml-chip{cursor:pointer}
.cml-card{display:flex;flex-direction:column;gap:${u(2.5)};border:1px solid var(--color-border);border-radius:var(--radius-2xl);padding:${u(4)};background:var(--color-background-secondary-soft-alpha)}
.cml-card-title{font-weight:600;font-size:var(--text-sm)}
.cml-card-detail{font-size:var(--text-sm);color:var(--color-text-secondary)}
.cml-card-actions{display:flex;flex-wrap:wrap;gap:${u(2)}}
.cml-prompt{display:flex;flex-direction:column;gap:${u(2)}}
.cml-choices{display:flex;flex-wrap:wrap;gap:${u(1.5)}}
.cml-choice{border:1px solid var(--color-border);border-radius:var(--radius-full);padding:${u(1)} ${u(3)};background:transparent;color:var(--color-text);font:inherit;font-size:var(--text-sm);cursor:pointer}
.cml-choice[aria-checked=true]{background:var(--color-background-primary-soft-alpha)}
.cml-input{border:1px solid var(--color-border);border-radius:var(--radius-lg);padding:${u(1.5)} ${u(2.5)};background:transparent;color:var(--color-text);font:inherit;font-size:var(--text-sm)}
.cml-header{display:flex;align-items:center;justify-content:space-between;gap:${u(3)};padding:${u(2)} ${u(4)}}
.cml-header-text{min-width:0}
.cml-header-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:var(--text-sm)}
.cml-header-subtitle{font-size:var(--text-xs);color:var(--color-text-secondary)}
.cml-header-actions{display:flex;gap:${u(1.5)}}
.cml-composer{display:flex;flex-direction:column;gap:${u(2)};margin-inline:auto;width:100%;max-width:var(--thread-content-max-width);border:1px solid var(--color-border);border-radius:var(--radius-2xl);padding:${u(3)}}
.cml-composer-input{resize:none;border:0;outline:none;background:transparent;color:var(--color-text);font:inherit;font-size:var(--text-base)}
.cml-composer-bar{display:flex;align-items:center;justify-content:space-between;gap:${u(2)}}
.cml-attachments{display:flex;flex-wrap:wrap;gap:${u(1.5)}}
.cml-chip-remove{border:0;padding:0;background:transparent;color:var(--color-text-secondary);font:inherit;cursor:pointer}
.cml-composer-pickers{display:flex;flex-wrap:wrap;align-items:center;gap:${u(1)}}
.cml-row{position:relative;display:flex;align-items:center;border-radius:var(--radius-lg)}
.cml-row:hover,.cml-row[data-selected]{background:var(--color-background-primary-ghost-hover)}
.cml-row-open{display:flex;flex:1;align-items:center;gap:${u(2)};min-width:0;height:var(--height-token-row);border:0;padding-inline:var(--padding-row-x);background:transparent;color:var(--color-text);font:inherit;font-size:var(--text-sm);text-align:start;cursor:pointer}
.cml-row-mark{display:inline-flex;flex-shrink:0;align-items:center;justify-content:center;width:${u(3)}}
.cml-row-dot{width:${u(1.5)};height:${u(1.5)};border-radius:var(--radius-full);background:var(--color-text-info)}
.cml-row-dot[data-tone=waiting]{background:var(--color-text-warning)}
.cml-row-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cml-row-badges{display:inline-flex;flex-shrink:0;align-items:center;gap:${u(1)};font-size:var(--text-xs)}
.cml-row-time{flex-shrink:0;font-size:var(--text-xs);color:var(--color-text-tertiary)}
.cml-row-menu{display:none;position:absolute;inset-inline-end:${u(1)}}
.cml-row:hover .cml-row-menu{display:inline-flex}
.cml-row:hover .cml-row-time{visibility:hidden}
.cml-drop{position:relative;display:flex;flex-direction:column;min-height:0;border-radius:var(--radius-xl)}
.cml-drop[data-over]{outline:2px solid var(--color-text-info);outline-offset:-2px;background:var(--color-background-primary-soft-alpha)}
`;
