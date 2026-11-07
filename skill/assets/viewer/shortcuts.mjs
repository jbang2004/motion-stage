export function installShortcuts({documentRef=globalThis.document,windowRef=globalThis.window,mode,search,play,step,clear,undo,redo}){
 const handler=e=>{
  if(e.defaultPrevented||e.altKey||e.isComposing)return;
  const target=e.target;
  if(target?.isContentEditable||/INPUT|TEXTAREA|SELECT/.test(target?.tagName))return;
  if(documentRef.querySelector('dialog[open]'))return;
  if(e.metaKey||e.ctrlKey){if(e.key?.toLowerCase()==='z'){const action=e.shiftKey?redo:undo;if(action){e.preventDefault();action();}}return;}
  const list=target?.closest?.('[role="tablist"]');
  if(list&&['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){
   const tabs=[...list.querySelectorAll('[role="tab"]')].filter(t=>!t.disabled),at=tabs.indexOf(target),index=e.key==='Home'?0:e.key==='End'?tabs.length-1:(at+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
   if(tabs[index]){e.preventDefault();tabs[index].focus();tabs[index].click();}return;
  }
  if(documentRef.querySelector('dialog[open]'))return;
  if(e.key==='/'){e.preventDefault();search(mode());}
  else if(e.code==='Space'&&!target?.closest?.('button,a,summary')){e.preventDefault();play();}
  else if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();step(e.key==='ArrowLeft'?-1:1);}
  else if(e.key==='Escape')clear();
 };
 windowRef.addEventListener('keydown',handler);return ()=>windowRef.removeEventListener('keydown',handler);
}
