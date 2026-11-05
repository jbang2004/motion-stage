import {element as el,icon,createActionButton} from './ui.mjs';
export const displayActionName=name=>String(name||'').replace(/^[A-Z][A-Z0-9]*_(?:AS|ANIM|ANIMATION)_/,'').replace(/_Seq$/i,'').replace(/_/g,' ');

export function createCharacterActions({api,getTarget,getPreset,getSelection=()=>({}),onPreset,onPreview,onCharacter,onError}){
 const $=id=>document.getElementById(id),picker=$('inlineCharacterSelect'),query=$('inlineActionSearch'),status=$('inlineActionStatus'),presets=$('sidebarClipList'),extras=$('compatibleActionList'),savedHost=$('savedActionList'),all=$('inlineAllActionList');
 let identity='',generation=0,data=null,timer=null,loading=false,queryTimer,limit=60,needsLoad=false,playGeneration=0,pendingAction=null,lastCharacter=null,activeAction=null;
 const relocate=()=>{const mount=$(innerWidth<=760?'mobileActionMount':'desktopActionMount');if($('inlineActionPanel').parentElement!==mount)mount.append($('inlineActionPanel'));};relocate();window.addEventListener('resize',relocate);
 const key=()=>JSON.stringify(getTarget());
 const current=(ticket,identity)=>ticket===generation&&identity===key();
 const revealStage=()=>{if(innerWidth<=760)document.getElementById('stage')?.scrollIntoView?.({block:'center',behavior:globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});};
 function button(name,detail,badge,kind,action,selected=false){
  const b=createActionButton('',action,{className:'sidebar-clip'+(kind==='preset'?'':' external-action')+(selected?' active':''),onError}),text=el('span');
  b.setAttribute('aria-pressed',String(selected));text.append(el('b',name),el('small',detail));b.append(icon('motion'),text,el('i',badge,'action-origin-badge '+kind));return b;
 }
 async function play(row){const ticket=generation,playTicket=++playGeneration,identity=key();pendingAction=playTicket;status.textContent='正在载入动作 · '+displayActionName(row.name);
  try{const response=await api('/api/actions/preview','POST',{...getTarget(),actionId:row.id});if(!current(ticket,identity)||playTicket!==playGeneration)return;await onPreview(response.result,response.request,()=>current(ticket,identity)&&playTicket===playGeneration);if(!current(ticket,identity)||playTicket!==playGeneration)return;activeAction=row.id;revealStage();sync();if(current(ticket,identity))status.textContent='已载入动作，可直接切换其他动作。';}finally{if(pendingAction===playTicket)pendingAction=null;}
 }
 async function playSaved(action){const ticket=generation,playTicket=++playGeneration,identity=key(),request={...getTarget(),packId:action.recipe.packId,versionId:action.recipe.versionId,clip:action.recipe.clip,...(action.recipe.mappingId?{mappingId:action.recipe.mappingId}:{})},result=await api('/api/motions/preview','POST',request);if(current(ticket,identity)&&playTicket===playGeneration){await onPreview(result,request,()=>current(ticket,identity)&&playTicket===playGeneration);if(!current(ticket,identity)||playTicket!==playGeneration)return;revealStage();draw();}}
 function draw(){
  const value=query.value.trim().toLowerCase(),mode=$('inlineActionFilter').value,selection=getSelection(),matches=text=>String(text).toLowerCase().includes(value);
  const presetButtons=getPreset().filter(c=>matches(c.name+' '+displayActionName(c.name))).map(c=>button(c.name,c.duration.toFixed(2)+' s','预设','preset',()=>{playGeneration++;pendingAction=null;activeAction=null;onPreset(c.name);revealStage();},selection.presetName===c.name));
  const rows=(data?.actions||[]).filter(a=>(mode==='variants'?a.presetVariant:!a.presetVariant||Boolean(value))&&matches(a.name+' '+displayActionName(a.name)+' '+a.sourceName));
  const externalButtons=rows.slice(0,limit).map(row=>{const b=button(displayActionName(row.name),row.sourceName,row.presetVariant?'其他版本':'兼容','compatible',()=>play(row),activeAction===row.id);b.title='骨架匹配 · '+row.name+' · '+row.sourceName;return b;});
  const savedButtons=(data?.saved||[]).filter(a=>data.saved.findLast(x=>x.name===a.name)?.id===a.id&&matches(a.name)).map(a=>button(a.name,'固定版本 · v'+a.number,'已保存','saved',()=>playSaved(a),selection.recipeId===a.recipe.id));
  presets.replaceChildren();extras.replaceChildren();savedHost.replaceChildren();all.replaceChildren();all.hidden=mode!=='all';$('presetActionGroup').hidden=mode!=='preset';$('compatibleActionGroup').hidden=!['compatible','variants'].includes(mode);$('savedActionGroup').hidden=mode==='all'||mode==='preset'||!savedButtons.length;
  if(mode==='all'){
   // Real DOM order follows the visible list, including keyboard navigation.
   for(let i=0;i<Math.max(presetButtons.length,externalButtons.length,savedButtons.length);i++)all.append(...[savedButtons[i],presetButtons[i],externalButtons[i]].filter(Boolean));
  }else{if(mode==='preset')presets.append(...presetButtons);else extras.append(...externalButtons);savedHost.append(...savedButtons);}
  const host=mode==='all'?all:extras;
  if(rows.length>limit&&mode!=='preset')host.append(createActionButton('显示更多（'+Math.min(limit,rows.length)+' / '+rows.length+'）',()=>{limit+=60;draw();},{className:'inline-more-actions',onError}));
  if(!externalButtons.length&&mode!=='preset')host.append(el('p',data?.state==='scanning'?'正在后台查找兼容动作，预设可直接播放。':value?'没有匹配的其他动作。':'已检查的来源中，没有额外的直接兼容动作。','inline-action-empty'));
  $('compatibleActionCount').textContent=rows.length;
 }
 async function load(force=false){if(loading)return;const target=getTarget();if(!target?.assetId||!target.expectedModelSha)return;const ticket=generation,identity=key();loading=true;needsLoad=false;
  try{const result=await api('/api/actions?'+new URLSearchParams({...target,...(force?{refresh:'1'}:{})}));if(!current(ticket,identity))return;data=result;picker.replaceChildren();for(const c of result.characters)picker.append(new Option(c.name,c.id));if(!result.characters.some(c=>c.id===target.assetId))picker.prepend(new Option('当前素材',target.assetId));picker.value=target.assetId;picker.disabled=!result.characters.length;
   if(pendingAction===null)status.textContent=result.state==='scanning'?'自动匹配中 · '+result.checked+' / '+result.total+' 个来源':result.state==='failed'?'匹配未完成：'+result.error:result.state==='partial'?'已显示部分结果 · 可重新匹配':getPreset().length+' 预设 · '+result.actions.filter(a=>!a.presetVariant).length+' 其他兼容';draw();if(result.state==='scanning')timer=setTimeout(()=>load(),1200);
  }catch(e){if(current(ticket,identity))status.textContent='匹配暂未完成：'+e.message;}finally{loading=false;if(needsLoad){needsLoad=false;void load();}else if(identity!==key())sync();}
 }
 function sync(){const next=key();if(next!==identity){identity=next;generation++;playGeneration++;pendingAction=null;activeAction=null;clearTimeout(timer);data=null;status.textContent='正在匹配此角色的可用动作…';const actor=getTarget()?.assetId;if(actor&&lastCharacter&&actor!==lastCharacter){query.value='';limit=60;}if(actor)lastCharacter=actor;if(!loading)void load();else needsLoad=true;}draw();}
 query.oninput=()=>{limit=60;clearTimeout(queryTimer);queryTimer=setTimeout(draw,100);};$('inlineActionFilter').onchange=()=>{limit=60;draw();};
 picker.onchange=async()=>{const id=picker.value;picker.disabled=true;try{await onCharacter(id,{character:Boolean(data?.characters.find(c=>c.id===id)?.projectCharacter)});}catch(e){onError(e);}finally{picker.disabled=false;sync();}};
 $('refreshCompatibleActions').onclick=()=>{clearTimeout(timer);void load(true);};
 return {sync,draw,cancelPreview(){playGeneration++;pendingAction=null;activeAction=null;},refresh(){clearTimeout(timer);void load();}};
}
