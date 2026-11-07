// The kit's stylesheet (docs/design/framework-ui.md F3). The app's utility classes differ by build, so the kit does not lean on them: every colour, font and radius here is one of
// the app's own variables, checked on each supported build, and what is left is geometry in its spacing unit. The theme owns how all of it looks. NO NODE API.

const u = (n) => `calc(var(--spacing) * ${n})`;

export const KIT_CSS = `
.cmk-glyph{display:inline-block;flex-shrink:0;vertical-align:middle}
.cmk-spin{animation:cmk-spin 1s linear infinite}
@keyframes cmk-spin{to{transform:rotate(360deg)}}

.cmk-tile{display:flex;flex-shrink:0;align-items:center;justify-content:center;width:${u(10)};height:${u(10)};border-radius:var(--radius-lg);background:var(--color-background-secondary-soft-alpha);color:var(--color-text-secondary)}
.cmk-tile[data-size=sm]{width:${u(8)};height:${u(8)}}
.cmk-tile[data-tone=danger]{color:var(--color-text-danger)}
.cmk-tile[data-tone=warning]{color:var(--color-text-warning)}
.cmk-tile[data-tone=success]{color:var(--color-text-success)}
.cmk-tile[data-tone=info]{color:var(--color-text-info)}

.cmk-badge{display:inline-flex;flex-shrink:0;align-items:center;gap:${u(1)};min-width:0;max-width:${u(45)};overflow:hidden;white-space:nowrap;border-radius:var(--radius-full);padding-inline:${u(1.5)};font-size:var(--text-xs);line-height:${u(4)};background:var(--color-background-secondary-soft-alpha);color:var(--color-text-secondary)}
.cmk-badge[data-tone=success]{background:var(--color-background-success-surface);color:var(--color-text-success)}
.cmk-badge[data-tone=warning]{background:var(--color-background-warning-soft-alpha);color:var(--color-text-warning)}
.cmk-badge[data-tone=danger]{background:var(--color-background-danger-soft-alpha);color:var(--color-text-danger)}
.cmk-badge[data-tone=info]{background:var(--color-background-info-soft);color:var(--color-text-info)}

.cmk-banner{display:flex;width:100%;align-items:center;gap:${u(3)};padding-block:${u(4)};padding-inline:${u(5)} ${u(3)};border:1px solid var(--color-border);border-radius:var(--radius-3xl);background:var(--color-surface);color:var(--color-text);font-size:var(--text-sm)}
.cmk-banner-icon{display:flex;flex-shrink:0;color:var(--color-text-secondary)}
.cmk-banner[data-tone=danger] .cmk-banner-icon{color:var(--color-text-danger)}
.cmk-banner[data-tone=warning] .cmk-banner-icon{color:var(--color-text-warning)}
.cmk-banner[data-tone=success] .cmk-banner-icon{color:var(--color-text-success)}
.cmk-banner[data-tone=info] .cmk-banner-icon{color:var(--color-text-info)}
.cmk-banner-text{display:flex;flex:1;flex-direction:column;gap:${u(0.5)};min-width:0}
.cmk-banner-title{margin:0;font-size:var(--text-sm);font-weight:600}
.cmk-banner-message{color:var(--color-text-secondary)}
.cmk-banner-actions{display:flex;flex-wrap:wrap;flex-shrink:0;gap:${u(2)}}

.cmk-empty{display:flex;width:100%;flex-direction:column;align-items:center;justify-content:center;gap:${u(5)};padding:${u(6)} ${u(3)};min-height:${u(60)};text-align:center;user-select:none}
.cmk-empty-head{display:flex;flex-direction:column;align-items:center;gap:${u(3)}}
.cmk-empty-text{display:flex;flex-direction:column;align-items:center;gap:${u(0.5)}}
.cmk-empty-title{margin:0;font-size:var(--text-lg);font-weight:400;color:var(--color-text)}
.cmk-empty-description{margin:0;font-size:var(--text-sm);color:var(--color-text-secondary)}
.cmk-empty-actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:${u(2)}}

.cmk-search{display:flex;align-items:center;gap:${u(2)};min-width:0;height:var(--height-page-search);padding-inline:${u(2.5)};border:1px solid var(--color-border-primary-outline);border-radius:var(--radius-full);background:var(--color-background-page-search);color:var(--color-text);font-size:var(--text-base)}
.cmk-search-icon{display:flex;flex-shrink:0;color:var(--color-text-tertiary)}
.cmk-search-input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:inherit;font:inherit}
.cmk-search-input::placeholder{color:var(--color-text-tertiary)}
.cmk-search-clear{display:flex;flex-shrink:0;align-items:center;justify-content:center;padding:0;border:0;background:transparent;color:var(--color-text-tertiary);cursor:pointer}

.cmk-segmented{display:inline-flex;align-items:center;gap:${u(0.5)};min-width:0;max-width:100%;overflow-x:auto}
.cmk-segment{height:${u(7)};padding-inline:${u(2.5)};border:0;border-radius:var(--radius-lg);background:transparent;color:var(--color-text-tertiary);font-size:var(--text-sm);white-space:nowrap;cursor:pointer}
.cmk-segment:hover{background:var(--color-background-primary-ghost-hover)}
.cmk-segment[aria-pressed=true]{background:var(--color-background-segmented-selected);color:var(--color-text)}
.cmk-segment:disabled{opacity:.4;cursor:default}

.cmk-tabs{display:flex;align-items:center;gap:${u(1)};min-width:0;overflow-x:auto}
.cmk-tab{display:inline-flex;flex-shrink:0;align-items:center;gap:${u(1.5)};height:${u(9)};padding-inline:${u(4)};border:0;border-radius:var(--radius-full);background:transparent;color:var(--color-text-secondary);font-size:var(--text-sm);font-weight:500;cursor:pointer}
.cmk-tab:hover{color:var(--color-text)}
.cmk-tab[aria-selected=true]{background:var(--color-background-primary-ghost-hover);color:var(--color-text)}
.cmk-tab-count{color:var(--color-text-tertiary);font-weight:400;font-variant-numeric:tabular-nums}
.cmk-tab-dot{width:${u(1.5)};height:${u(1.5)};border-radius:var(--radius-full);background:var(--color-text-danger)}

.cmk-check{display:inline-flex;flex-shrink:0;align-items:center;justify-content:center;width:${u(4)};height:${u(4)};padding:0;border:1px solid var(--color-border-strong);border-radius:var(--radius-sm);background:transparent;color:var(--color-background-primary-solid);cursor:pointer}
.cmk-check[aria-checked=true]{border-color:var(--color-background-primary-solid)}
.cmk-check:disabled{opacity:.4;cursor:default}

.cmk-select{display:inline-flex;align-items:center;justify-content:space-between;gap:${u(1)};max-width:100%;height:${u(7)};padding-inline:${u(3)};border:1px solid var(--color-border);border-radius:var(--radius-button-toolbar);background:var(--color-background-primary-soft-alpha);color:var(--color-text);font-size:var(--text-sm);white-space:nowrap;cursor:pointer}
.cmk-select:hover{background:var(--color-background-primary-ghost-hover)}
.cmk-select:disabled{opacity:.4;cursor:default}
.cmk-select-value{overflow:hidden;text-overflow:ellipsis}
.cmk-select-chevron{display:flex;flex-shrink:0;color:var(--color-text-tertiary)}
.cmk-more{display:inline-flex;align-items:center;justify-content:center;gap:${u(1)};min-width:${u(7)};height:${u(7)};padding-inline:${u(1)};border:0;border-radius:var(--radius-lg);background:transparent;color:var(--color-text-secondary);font-size:var(--text-sm);cursor:pointer}
.cmk-more:hover{background:var(--color-background-primary-ghost-hover);color:var(--color-text)}
.cmk-more:disabled{opacity:.4;cursor:default}
.cmk-item{display:flex;align-items:center;gap:${u(2)}}
.cmk-item[data-danger]{color:var(--color-text-danger)}
.cmk-menu-rule{height:1px;margin-block:${u(1)};background:var(--color-border)}

.cmk-meta{font-size:var(--text-xs);color:var(--color-text-tertiary);font-variant-numeric:tabular-nums}
.cmk-list{display:flex;flex-direction:column;gap:${u(4)}}
.cmk-list-search{display:flex;justify-content:flex-end}
.cmk-head{display:inline-flex;align-items:baseline;gap:${u(1.5)};font-size:var(--text-xs);font-weight:500;color:var(--color-text)}
.cmk-head[data-tone=danger]{color:var(--color-text-danger)}
.cmk-count{color:var(--color-text-tertiary);font-weight:400;font-variant-numeric:tabular-nums}
.cmk-row{position:relative;display:flex;align-items:center;gap:${u(3)};min-height:var(--height-token-settings-row,${u(16)});padding-inline-end:${u(4)}}
.cmk-row:hover{background:var(--color-background-primary-ghost-hover)}
.cmk-row-main{display:flex;flex:1;align-items:center;align-self:stretch;gap:${u(3)};min-width:0;padding:${u(3)} 0 ${u(3)} ${u(4)};border:0;background:transparent;color:inherit;font:inherit;text-align:start;cursor:pointer}
.cmk-row-text{display:flex;flex:1;flex-direction:column;min-width:0}
.cmk-row-name{display:flex;align-items:center;gap:${u(1.5)};min-width:0;font-size:var(--text-sm);font-weight:500;color:var(--color-text-secondary)}
.cmk-row-name[data-on]{color:var(--color-text)}
.cmk-row-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cmk-row-sub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--text-xs);font-weight:400;color:var(--color-text-secondary)}
.cmk-row-sub[data-tone=danger]{color:var(--color-text-danger)}
.cmk-row-controls{display:flex;flex-shrink:0;align-items:center;gap:${u(2)}}
.cmk-title{display:flex;align-items:flex-start;justify-content:space-between;gap:${u(6)}}
.cmk-title-text{display:flex;flex:1;flex-direction:column;gap:${u(1)};min-width:0}
.cmk-title-text h1{margin:0}
.cmk-title-description{margin:0;font-size:var(--text-base);color:var(--color-text-secondary);text-wrap:pretty}
.cmk-title-actions{display:flex;flex-shrink:0;align-items:center;gap:${u(2)};min-height:${u(10)}}
.cmk-status{display:flex;flex-wrap:wrap;align-items:center;gap:${u(1.5)};font-size:var(--text-sm);color:var(--color-text-secondary);font-variant-numeric:tabular-nums}
.cmk-status-dot{width:${u(1.5)};height:${u(1.5)};border-radius:var(--radius-full);background:var(--color-text-tertiary)}
.cmk-status[data-tone=success] .cmk-status-dot{background:var(--color-text-success)}
.cmk-status[data-tone=danger] .cmk-status-dot{background:var(--color-text-danger)}
.cmk-status[data-tone=warning] .cmk-status-dot{background:var(--color-text-warning)}
.cmk-status[data-tone=info] .cmk-status-dot{background:var(--color-text-info)}
.cmk-status[data-tone=success] .cmk-status-word{color:var(--color-text)}
.cmk-status[data-tone=danger] .cmk-status-word{color:var(--color-text-danger)}
.cmk-status[data-tone=warning] .cmk-status-word{color:var(--color-text-warning)}
.cmk-status[data-tone=info] .cmk-status-word{color:var(--color-text-info)}
.cmk-page{display:flex;flex-direction:column;gap:${u(8)}}
.cmk-page-body{display:flex;flex-direction:column;gap:${u(6)}}
.cmk-stack{display:flex;flex-direction:column;gap:var(--settings-section-gap,${u(10)})}
.cmk-tight{display:flex;flex-direction:column;gap:${u(4)}}
.cmk-paragraph{margin:0;max-width:64ch;font-size:var(--text-base)}
.cmk-error{margin:0;font-size:var(--text-sm);color:var(--color-text-danger)}
.cmk-line{margin:0;font-size:var(--text-sm)}
.cmk-line[data-tone=secondary]{color:var(--color-text-secondary)}
.cmk-media-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(${u(60)},1fr));gap:${u(3)}}
.cmk-media{display:flex;flex-direction:column;gap:${u(1.5)};margin:0}
.cmk-media-frame{display:flex;width:100%;align-items:center;justify-content:center;overflow:hidden;border:1px solid var(--color-border);border-radius:var(--radius-xl);background:var(--color-surface-secondary);color:var(--color-text-tertiary)}
.cmk-media-frame img{width:100%;height:100%;object-fit:cover}
.cmk-media-caption{font-size:var(--text-xs);color:var(--color-text-secondary)}
.cmk-setting{position:relative;display:flex;flex-direction:column}
.cmk-setting-row{display:flex;align-items:center;justify-content:space-between;gap:${u(6)};min-height:${u(13)};padding:${u(3)} ${u(4)}}
.cmk-setting-lead{display:flex;flex:1;align-items:flex-start;gap:${u(1)};min-width:0}
.cmk-setting-icon{display:flex;flex-shrink:0;width:${u(5)};padding-top:${u(0.5)};color:var(--color-text-secondary)}
.cmk-setting-text{display:flex;flex-direction:column;gap:${u(0.5)};min-width:0}
.cmk-setting-title{display:flex;align-items:center;gap:${u(1.5)};font-size:var(--text-sm);font-weight:500;color:var(--color-text)}
.cmk-changed{flex-shrink:0;width:${u(1.5)};height:${u(1.5)};border-radius:var(--radius-full);background:var(--color-background-info-solid)}
.cmk-setting-description{font-size:var(--text-xs);color:var(--color-text-secondary)}
.cmk-setting-needs{display:flex;align-items:center;gap:${u(1)};font-size:var(--text-xs);color:var(--color-text-secondary)}
.cmk-setting-needs .cmk-glyph{color:var(--color-text-warning)}

.cmk-summary{display:flex;align-items:flex-start;gap:${u(3)}}
.cmk-summary-text{display:flex;flex:1;flex-direction:column;gap:${u(1)};min-width:0}
.cmk-summary-title{margin:0;font-size:var(--text-lg);font-weight:600}
.cmk-summary-actions{display:flex;flex-wrap:wrap;flex-shrink:0;align-items:center;gap:${u(2)}}
.cmk-panel{display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--color-border);border-radius:var(--radius-2xl);background:var(--color-surface)}
.cmk-panel-head{display:flex;align-items:center;gap:${u(3)};min-height:${u(16)};padding:${u(3)} ${u(4)}}
.cmk-panel-note{display:flex;align-items:flex-start;gap:${u(2)};padding:${u(2.5)} ${u(4)};border-top:1px solid var(--color-border);background:var(--color-surface-secondary);font-size:var(--text-xs);color:var(--color-text-secondary)}
.cmk-notes{margin:0;padding:${u(4)} ${u(4)} ${u(4)} ${u(9)};border-radius:var(--radius-2xl);background:var(--color-surface-secondary);font-size:var(--text-sm);line-height:1.5}
.cmk-groups{display:flex;flex-direction:column;gap:${u(3)}}
.cmk-groups-head{display:flex;align-items:baseline;justify-content:space-between;gap:${u(3)};padding-inline-end:${u(5)}}
.cmk-group{display:flex;flex-direction:column;gap:${u(1)};padding:${u(1)};border-radius:var(--radius-2xl);background:var(--color-surface-secondary)}
.cmk-group[data-tone=danger]{background:var(--color-background-danger-soft-alpha)}
.cmk-group[data-tone=warning]{background:var(--color-background-warning-soft-alpha)}
.cmk-group[data-tone=info]{background:var(--color-background-info-soft)}
.cmk-group[data-tone=success]{background:var(--color-background-success-surface)}
.cmk-group-head{display:flex;align-items:center;gap:${u(2)};min-height:${u(9)};padding-inline:${u(3)}}
.cmk-group-label{font-size:var(--text-sm);font-weight:500;color:var(--color-text)}
.cmk-group-note{flex:1;font-size:var(--text-xs);color:var(--color-text-secondary)}
.cmk-group[data-tone=danger] .cmk-group-head .cmk-glyph,.cmk-group[data-tone=danger] .cmk-group-label{color:var(--color-text-danger)}
.cmk-group[data-tone=warning] .cmk-group-head .cmk-glyph,.cmk-group[data-tone=warning] .cmk-group-label{color:var(--color-text-warning)}
.cmk-group[data-tone=info] .cmk-group-head .cmk-glyph,.cmk-group[data-tone=info] .cmk-group-label{color:var(--color-text-info)}
.cmk-group[data-tone=success] .cmk-group-head .cmk-glyph,.cmk-group[data-tone=success] .cmk-group-label{color:var(--color-text-success)}
.cmk-group-rows{display:flex;flex-direction:column;border:1px solid var(--color-border);border-radius:var(--radius-xl);background:var(--color-surface)}
.cmk-vrow{display:flex;align-items:center;gap:${u(3)};padding:${u(3)} ${u(4)}}
.cmk-vrow+.cmk-vrow{border-top:1px solid var(--color-border)}
.cmk-vrow-text{display:flex;flex:1;flex-direction:column;gap:${u(0.5)};min-width:0}
.cmk-vrow-name{display:flex;align-items:baseline;gap:${u(1.5)};font-size:var(--text-sm);font-weight:500;color:var(--color-text)}
.cmk-vrow-why{font-size:var(--text-xs);color:var(--color-text-secondary)}
.cmk-pair{display:flex;flex-shrink:0;align-items:center;gap:${u(1.5)};color:var(--color-text-tertiary)}
.cmk-pair-now{display:flex;color:var(--color-text-secondary)}
.cmk-pair-after{display:flex;align-items:center;justify-content:center;width:${u(7)};height:${u(7)};border-radius:var(--radius-full);background:var(--color-background-secondary-soft-alpha);color:var(--color-text-secondary)}
.cmk-pair-now[data-tone=success],.cmk-pair-after[data-tone=success]{color:var(--color-text-success)}
.cmk-pair-now[data-tone=danger],.cmk-pair-after[data-tone=danger]{color:var(--color-text-danger)}
.cmk-pair-now[data-tone=warning],.cmk-pair-after[data-tone=warning]{color:var(--color-text-warning)}
.cmk-pair-now[data-tone=info],.cmk-pair-after[data-tone=info]{color:var(--color-text-info)}
.cmk-pair-after[data-tone=success]{background:var(--color-background-success-surface)}
.cmk-pair-after[data-tone=danger]{background:var(--color-background-danger-soft-alpha)}
.cmk-pair-after[data-tone=warning]{background:var(--color-background-warning-soft-alpha)}
.cmk-pair-after[data-tone=info]{background:var(--color-background-info-soft)}
.cmk-setting-allow{padding:0;border:0;background:transparent;color:var(--color-text);font:inherit;font-weight:600;text-decoration:underline;cursor:pointer}
.cmk-setting-allow:disabled{opacity:.4;cursor:default}
.cmk-setting-error{font-size:var(--text-xs);color:var(--color-text-danger)}
.cmk-setting-control{display:flex;flex-shrink:0;align-items:center;gap:${u(2)}}
.cmk-setting-stacked{padding:0 ${u(4)} ${u(3)} ${u(4)}}
.cmk-setting-stacked[data-icons]{padding-inline-start:${u(10)}}
.cmk-setting-reset{opacity:0;transition:opacity .15s}
.cmk-setting:hover .cmk-setting-reset,.cmk-setting-reset:focus-visible{opacity:1}
.cmk-setting-media{padding:${u(3)}}
.cmk-group-title{display:inline-flex;align-items:center;gap:${u(1.5)}}
.cmk-input,.cmk-color,.cmk-times,.cmk-stepper,.cmk-time-single,.cmk-shortcut-chip{height:${u(7)};border:1px solid var(--color-border);border-radius:var(--radius-full);background:transparent;color:var(--color-text);font-size:var(--text-sm)}
.cmk-input{width:${u(52)};max-width:100%;padding-inline:${u(3)};outline:0}
.cmk-input:focus,.cmk-area:focus,.cmk-list-input:focus,.cmk-color:focus-within,.cmk-times:focus-within,.cmk-stepper:focus-within,.cmk-time-single:focus{border-color:var(--color-ring)}
.cmk-area{display:block;width:100%;min-height:${u(18)};padding:${u(2)} ${u(3)};resize:vertical;border:1px solid var(--color-border);border-radius:var(--radius-xl);background:transparent;color:var(--color-text);font-size:var(--text-sm);outline:0}
.cmk-stepper{display:inline-flex;align-items:center;justify-content:space-between;width:${u(32)};padding-inline:${u(0.5)}}
.cmk-stepper-button{display:flex;flex-shrink:0;align-items:center;justify-content:center;width:${u(6)};height:${u(6)};padding:0;border:0;border-radius:var(--radius-full);background:transparent;color:var(--color-text-secondary);cursor:pointer}
.cmk-stepper-button:hover{background:var(--color-background-primary-ghost-hover)}
.cmk-stepper-button:disabled{opacity:.4;cursor:default}
.cmk-stepper-value{display:inline-flex;flex:1;align-items:baseline;justify-content:center;gap:${u(1)};min-width:0;font-variant-numeric:tabular-nums}
.cmk-stepper-input{width:${u(10)};min-width:0;padding:0;border:0;outline:0;background:transparent;color:inherit;font:inherit;text-align:end}
.cmk-stepper-unit{color:var(--color-text-secondary);font-size:var(--text-xs)}
.cmk-slider{display:inline-flex;align-items:center;gap:${u(2)};width:${u(52)}}
.cmk-slider input{-webkit-appearance:none;appearance:none;flex:1;min-width:0;height:${u(1)};border-radius:var(--radius-full);background:linear-gradient(to right,var(--color-chart-blue) var(--cmk-fill,0%),var(--color-border-strong) var(--cmk-fill,0%));cursor:pointer}
.cmk-slider input::-webkit-slider-thumb{-webkit-appearance:none;width:${u(4)};height:${u(4)};border:1px solid var(--color-border-strong);border-radius:var(--radius-full);background:var(--color-surface)}
.cmk-slider input:focus-visible{outline:2px solid var(--color-ring);outline-offset:${u(1)}}
.cmk-slider input:disabled{opacity:.4;cursor:default}
.cmk-slider-value{width:${u(10)};text-align:end;font-size:var(--text-sm);font-variant-numeric:tabular-nums;color:var(--color-text-secondary)}
.cmk-shortcut{display:inline-flex;align-items:center;gap:${u(1)}}
.cmk-shortcut-chip{display:inline-flex;align-items:center;padding-inline:${u(2)};font:inherit;font-size:var(--text-sm);background:var(--color-background-secondary-soft-alpha)}
.cmk-shortcut-chip[data-recording]{border-color:var(--color-ring);outline:1px solid var(--color-ring)}
.cmk-color{display:inline-flex;align-items:center;gap:${u(1.5)};width:${u(24)};padding-inline:${u(2)}}
.cmk-color-swatch{position:relative;display:inline-block;flex-shrink:0;width:${u(3.5)};height:${u(3.5)};overflow:hidden;border-radius:var(--radius-full);border:1px solid var(--color-border)}
.cmk-color-swatch input{position:absolute;inset:0;opacity:0;cursor:pointer}
.cmk-color-input{flex:1;width:100%;min-width:0;padding:0;border:0;outline:0;background:transparent;color:inherit;font:inherit;text-transform:uppercase}
.cmk-times{display:inline-flex;align-items:center;gap:${u(1)};padding-inline:${u(2.5)};color:var(--color-text-secondary)}
.cmk-time-input{width:${u(10)};padding:0;border:0;outline:0;background:transparent;color:var(--color-text);font-size:var(--text-sm);text-align:center;font-variant-numeric:tabular-nums}
.cmk-time-single{width:${u(16)};border:1px solid var(--color-border);outline:0}
.cmk-thumbs{display:flex;flex-wrap:wrap;gap:${u(3)}}
.cmk-thumb{display:flex;flex-direction:column;align-items:center;gap:${u(1)};padding:0;border:0;background:transparent;color:var(--color-text-secondary);font-size:var(--text-xs);cursor:pointer}
.cmk-thumb[aria-checked=true]{color:var(--color-text);font-weight:500}
.cmk-thumb:disabled{opacity:.4;cursor:default}
.cmk-thumb-frame{display:flex;align-items:center;justify-content:center;width:${u(20)};height:${u(13)};overflow:hidden;border-radius:var(--radius-lg);border:1px solid var(--color-border);background:var(--color-surface-secondary);color:var(--color-text-tertiary)}
.cmk-thumb[aria-checked=true] .cmk-thumb-frame{outline:2px solid var(--color-ring);border-color:transparent}
.cmk-thumb-frame img{width:100%;height:100%;object-fit:cover}
.cmk-list-rows{display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--color-border);border-radius:var(--radius-xl);background:var(--color-surface)}
.cmk-list-row{display:flex;align-items:center;gap:${u(2)};min-height:${u(9)};padding-inline:${u(2)};border-top:1px solid var(--color-border)}
.cmk-list-row:first-child{border-top:0}
.cmk-list-row[data-dragging]{opacity:.4}
.cmk-list-row[data-drop=before]{box-shadow:inset 0 2px 0 var(--color-ring)}
.cmk-list-row[data-drop=after]{box-shadow:inset 0 -2px 0 var(--color-ring)}
.cmk-list-handle{display:flex;flex-shrink:0;padding:0;border:0;background:transparent;color:var(--color-text-tertiary);cursor:grab;touch-action:none}
.cmk-list-handle:disabled{cursor:default;opacity:.4}
.cmk-list-add{display:flex;flex-shrink:0;color:var(--color-text-tertiary)}
.cmk-list-input{flex:1;min-width:0;padding:0;border:0;outline:0;background:transparent;color:var(--color-text);font-size:var(--text-sm)}
.cmk-activity-actions{display:inline-flex;align-items:center;gap:${u(2)}}
.cmk-log{overflow-x:auto;margin:0;padding:${u(3)} ${u(4)};border:1px solid var(--color-border);border-radius:var(--radius-2xl);background:var(--color-surface-tertiary);color:var(--color-text);font-family:var(--font-mono);font-size:var(--text-xs);line-height:${u(4.5)};white-space:pre}
.cmk-log-line{display:flex;gap:${u(2)}}
.cmk-log-time{flex-shrink:0;color:var(--color-text-tertiary);font-variant-numeric:tabular-nums}
.cmk-log-level{flex-shrink:0;width:${u(10)};color:var(--color-text-tertiary)}
.cmk-log-line[data-level=warn] .cmk-log-level{color:var(--color-text-warning)}
.cmk-log-line[data-level=error] .cmk-log-level,.cmk-log-line[data-level=error] .cmk-log-message{color:var(--color-text-danger)}
.cmk-log-note{color:var(--color-text-tertiary)}
.cmk-fault{display:flex;flex-direction:column;gap:${u(0.5)}}
.cmk-stack-trace{margin:${u(3)} ${u(4)}}
.cmk-check-row{display:inline-flex;align-items:center;gap:${u(2)};font-size:var(--text-sm);cursor:pointer;white-space:nowrap;flex-shrink:0}
.cmk-segment:focus-visible,.cmk-tab:focus-visible,.cmk-check:focus-visible,.cmk-select:focus-visible,.cmk-more:focus-visible,.cmk-search-clear:focus-visible,.cmk-row-main:focus-visible,.cmk-stepper-button:focus-visible,.cmk-thumb:focus-visible,.cmk-list-handle:focus-visible{outline:2px solid var(--color-ring);outline-offset:0}
`;

export const KIT_STYLE_ID = 'codexmods-kit';
