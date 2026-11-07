// One serial writer per asset. A conflict never silently overwrites another
// window; the local draft remains available until the user resolves it.
// Playback advances timestamps and root display offsets without editing a draft.
// Pausing/seeking is captured separately by pausedTime; camera and request changes still save.
function fingerprint(draft){
 if(!draft)return JSON.stringify(draft);
 const value=structuredClone(draft),ctx=value.context;
 if(ctx){delete ctx.time;delete ctx.frame;for(const slot of Object.values(ctx.slots||{}))delete slot.time;for(const transform of Object.values(ctx.normalization||{}))delete transform.displayOffset;}
 return JSON.stringify(value);
}
export function createDraftSync({load,save,onStatus=()=>{}}){
 const entries=new Map();
 const entry=id=>{if(!entries.has(id))entries.set(id,{revision:null,draft:null,saved:'',pending:null,conflict:null});return entries.get(id);};
 async function restore(id,fallback){
  const e=entry(id);if(e.pending)await e.pending;
  if(e.revision!==null){onStatus(id,e.conflict?'conflict':e.saved===fingerprint(e.draft)?'saved':'offline');return e.draft;}
  try{const record=await load(id);e.revision=record.revision;e.draft=record.draft||fallback;e.saved=fingerprint(record.draft);onStatus(id,'saved');return e.draft;}
  catch{onStatus(id,'offline');return e.draft||fallback;}
 }
 function persist(id,draft){
  const e=entry(id);e.draft=structuredClone(draft);
  if(e.conflict||e.pending||e.saved===fingerprint(e.draft))return e.pending;
  e.pending=(async()=>{
   try{
    if(e.revision===null){const record=await load(id);e.revision=record.revision;if(record.draft){e.conflict=record;onStatus(id,'conflict');return;}}
    while(!e.conflict&&e.saved!==fingerprint(e.draft)){
     const value=structuredClone(e.draft);onStatus(id,'saving');
     const result=await save(id,{expectedRevision:e.revision,draft:value});
     if(result.conflict){e.conflict=result.current;onStatus(id,'conflict');return;}
     e.revision=result.revision;e.saved=fingerprint(value);onStatus(id,'saved');
    }
   }catch{onStatus(id,'offline');}finally{e.pending=null;}
  })();return e.pending;
 }
 async function resolve(id,choice){
  const e=entry(id),other=e.conflict;if(!other)return null;e.conflict=null;e.revision=other.revision;
  if(choice==='remote'){e.draft=other.draft;e.saved=fingerprint(other.draft);onStatus(id,'saved');return e.draft;}
  await persist(id,e.draft);return null;
 }
 return {restore,persist,resolve};
}
