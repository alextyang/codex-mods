// Synthetic renderer and main-process sources for the UI seam tests: the shapes of the app's sites (React's jsx-runtime wrapper, Vite's preload helper, the command
// tables, the menu item builder, the AppHost statements), small enough to read. Shared by seams.test.mjs and reseam-adapter.test.mjs.
/** A source over an in-memory file map. */
export const synth = (files) => ({ list: (prefix) => Object.keys(files).filter((p) => p.startsWith(prefix)), read: (p) => files[p], size: (p) => files[p].length });
export const MAP = (name) => `//# sourceMappingURL=${name}.js.map`;
// the shape of the React jsx-runtime wrapper (React's own code) and of Vite's preload helper (Vite's own code)
export const JSX_WRAPPER = 'var hoe=i((e=>{var t=Symbol.for(`react.transitional.element`),n=Symbol.for(`react.fragment`);function r(e,n,r){var i=null;if(r!==void 0&&(i=``+r),n.key!==void 0&&(i=``+n.key),`key`in n)for(var a in r={},n)a!==`key`&&(r[a]=n[a]);else r=n;return n=r.ref,{$$typeof:t,type:e,key:i,ref:n===void 0?null:n,props:r}}e.Fragment=n,e.jsx=r,e.jsxs=r}));';
export const VITE_HELPER = 'nh=function(e,t,n){let r=Promise.resolve();if(t&&t.length>0){let e=document.getElementsByTagName(`link`),i=document.querySelector(`meta[property=csp-nonce]`),a=i?.nonce||i?.getAttribute(`nonce`);function o(e){return Promise.all(e.map(e=>Promise.resolve(e).then(e=>({status:`fulfilled`,value:e}),e=>({status:`rejected`,reason:e}))))}r=o(t.map(t=>{if(t in th)return;th[t]=!0;return Promise.resolve()}))}function i(e){let t=new Event(`vite:preloadError`,{cancelable:!0});if(t.payload=e,window.dispatchEvent(t),!t.defaultPrevented)throw e}return r.then(t=>{for(let e of t||[])e.status===`rejected`&&i(e.reason);return e().catch(i)})}';
// the shape of the item builder of a thread's menus: its destructured parameters (the app's own names) and a flat list with separators
export const LAUNCHER_FILTER = 'function Bjl(e,{codexFeatureAccess:t,surface:n,target:r}){let i=t.status===`allowed`||t.status===`loading`;return e.filter(e=>!(e.requiresCodexAccess&&!i||!e.tabType?.dropDestinations.includes(r)||n===`new-tab`&&e.tabType?.showInNewTabLauncher===!1))}';
export const WORKSPACE_FILE_MENU_BUILDER = 'function O$a(e,{artifactNavigationTarget:t,attachmentPreviewOrigin:n,column:r,cwd:i,endLine:a,hostId:o,isAttachmentPreview:s,line:c,onOpenTargetSelected:l,openMode:u,openInSidePanel:d=!1,path:f},p=null){if(f==null)return[];return[{id:`workspace-file-copy-path`},{id:`workspace-file-reveal-path`}]}';
export const TAB_MENU_BUILDER = 'function nQi({scope:e,controller:t,onBeginRename:n,tab:r,placement:i=`tab-strip`,isSourceCurrent:a=()=>!0}){if(r==null)return[];return r.async?Promise.resolve([{id:`close-tab`}]):[{id:`close-tab`},{id:`close-other-tabs`}]}';
export const FILE_MENU_BUILDER = 'function ke({isLoadingOpenTargets:e=!1,onAddToChat:t,onCopyPath:n,onOpenInTarget:r,onSaveAs:i,primaryTarget:a,targetPath:o,visibleTargets:s}){if(o==null)return[];return[{id:`add-to-chat`},{id:`copy-path`}]}';
// the shapes of the markdown map builders (components, default directives): every markdown site's
export const MD_COMPONENTS_BUILDER = 'function xSd({allowWideBlocks:e,conversationId:t,cwd:n,externalLinkAppearance:r,externalResourcePolicy:i,hostId:s}){return{a:{link:t},code:{code:n}}}';
export const MD_DIRECTIVES_BUILDER = 'function bSd({conversationId:e,cwd:t,enableInlineDil:n,hostId:i,turnId:c}){return{appnote:{x:e},...n?{dil:1}:void 0}}';
export const MENU_BUILDER = 'async function BUc({scope:e,target:t,actions:n,onRename:r,surface:o,showForkInSidebar:d,canPin:f=!1}){let{conversationId:g}=t;await 0;return[{id:`rename-thread`},{id:`pin-thread`},{id:`continuation-separator`,type:`separator`},{id:`fork`,submenu:[{id:`fork-into-local`}]},{id:`copy-separator`,type:`separator`},{id:`copy-actions`}]}';
const shared = (body) => `import{a as e}from"./rolldown-runtime-0123456789ab.js";\n${body}\n${MAP('app-shared-aaaaaaaaaaaa')}`;
export const FIXTURE = {
  'webview/assets/app-shared-aaaaaaaaaaaa.js': shared(`${JSX_WRAPPER}var th={},nh;function h(){return(h=t((()=>{ate=1,${VITE_HELPER}})))()}`),
  'webview/assets/app-initial-bbbbbbbbbbbb.js': `var aBi,kbr;function q(){return(q=t((()=>{aBi=[{id:\`newTask\`,x:1},{id:\`other\`}],kbr=new Map([[\`newTask\`,()=>1],[\`other\`,()=>2]])})))()}${MENU_BUILDER}\n${LAUNCHER_FILTER}\n${MD_DIRECTIVES_BUILDER}${MD_COMPONENTS_BUILDER}\n${WORKSPACE_FILE_MENU_BUILDER}\n${TAB_MENU_BUILDER}\n${MAP('app-initial-bbbbbbbbbbbb')}`,
  'webview/assets/base-file-tree-dddddddddddd.js': `${FILE_MENU_BUILDER}\n${MAP('base-file-tree-dddddddddddd')}`,
  'webview/assets/command-messages-cccccccccccc.js': `var D={a:1};O={...D,"codex.command.importExternalAgent":\`Import\`,b:2};\n${MAP('command-messages-cccccccccccc')}`,
  '.vite/build/main-Zzzzzzzz.js': 'D.ipcMain.on(g.Tt,e=>{if(!F(e))return;let[t]=e.ports,n=d(e.sender),r=n?.createAppHost(e.sender),i=O1e(t,r);n?.registerAppView(e.sender,i).catch(e=>{p.r().warning(`Failed to register AppView RPC services`,{safe:{},sensitive:{error:e}})})})',
};
export const fx = (over = {}) => synth({ ...FIXTURE, ...over });
