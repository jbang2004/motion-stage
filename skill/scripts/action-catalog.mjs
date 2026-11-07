// Agent-facing view of 动作库: every action a character can play — its own
// clips plus auto-matched compatible actions — with the same categories and
// friendly labels the studio shows. Read-only; it never adopts or registers.
import {readProject,modelSlots} from './core.mjs';
import {discoverCharacterActions,waitForCharacterActions} from './character-actions.mjs';
import {ACTION_CATEGORIES,classifyAction,actionSearchText,compareActions} from '../assets/viewer/action-taxonomy.mjs';

const CATEGORY_IDS=new Set(ACTION_CATEGORIES.map(c=>c.id));

function describe(origin,{name,duration,...rest}){
 const info=classifyAction(name,{duration});
 return {origin,name,label:info.label,title:info.title,category:info.category,duration:Number(duration)||0,loop:info.loop,tags:info.tags,...rest,_search:actionSearchText(name,info)};
}

export async function actionCatalog(work,{assetId,slot='baseline',category,query='',limit=200,wait=false}={}){
 const cfg=await readProject(work),id=assetId||cfg.activeAssetId,model=cfg.models[id];
 if(!model)throw Error('角色尚未打开：先运行 open-character（或在动作库中点选角色），再查看动作。');
 const asset=modelSlots(cfg,id)[slot];if(!asset)throw Error('这个角色没有 '+slot+' 版本');
 if(category&&!CATEGORY_IDS.has(category))throw Error('未知类别：'+category+'。可用：'+[...CATEGORY_IDS].join(', '));
 const input={assetId:id,slot,expectedModelSha:asset.sha256};
 const scan=wait?await waitForCharacterActions(work,input):await discoverCharacterActions(work,input);
 const own=(asset.clips||[]).map(c=>describe('own',{name:c.name,duration:c.duration}));
 const matched=(scan.actions||[]).map(a=>describe('matched',{name:a.name,duration:a.duration,id:a.id,sourceName:a.sourceName,sourceCount:a.sourceCount,presetVariant:a.presetVariant}));
 const all=[...own,...matched],counts={};
 for(const row of all){counts[row.category]??={own:0,matched:0};counts[row.category][row.origin]++;}
 const q=String(query).trim().toLowerCase();
 const rows=all.filter(r=>(!category||r.category===category)&&(!q||r._search.includes(q))).sort((a,b)=>(a.origin===b.origin?0:a.origin==='own'?-1:1)||compareActions(a,b));
 const max=Math.max(1,Math.min(2000,Math.floor(Number(limit)||200)));
 return {
  assetId:id,name:model.name,slot,modelSha:asset.sha256,
  scan:{state:scan.state,checked:scan.checked,total:scan.total,incompatible:scan.incompatible,duplicates:scan.duplicates,error:scan.error},
  totals:{own:own.length,matched:matched.length},
  categories:ACTION_CATEGORIES.filter(c=>counts[c.id]).map(c=>({id:c.id,label:c.label,...counts[c.id]})),
  matchedQuery:rows.length,truncated:rows.length>max,
  actions:rows.slice(0,max).map(({_search,...row})=>row)
 };
}

// Compact human-readable listing for the CLI.
export function formatActionCatalog(result){
 const lines=[`${result.name} · 自带 ${result.totals.own} · 匹配 ${result.totals.matched}`+(result.scan.state==='scanning'?`（匹配尚未完成 ${result.scan.checked}/${result.scan.total}，去掉 --no-wait 可等待完成）`:'')];
 lines.push(result.categories.map(c=>`${c.label} ${c.own+c.matched}`).join(' · '));
 let current='';
 for(const row of result.actions){
  const heading=(row.origin==='own'?'角色自带':'匹配动作')+' / '+(ACTION_CATEGORIES.find(c=>c.id===row.category)?.label||row.category);
  if(heading!==current){lines.push('',heading);current=heading;}
  lines.push(`  ${row.label}  ·  ${row.name}  ·  ${row.duration.toFixed(2)}s${row.loop?' · 循环':''}${row.presetVariant?' · 其他版本':''}${row.id?'  [id '+row.id.slice(0,12)+']':''}`);
 }
 if(result.truncated)lines.push('',`… 共 ${result.matchedQuery} 个，使用 --limit 或 --category 缩小范围`);
 return lines.join('\n');
}
