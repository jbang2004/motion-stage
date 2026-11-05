// Older intake records used neighboring images as conservative cache hints.
// When an exact Blender consumption report exists, only those images establish
// authoring-source drift. Frozen old records are projected, never rewritten.
export function consumedDependencies(source){
 const dependencies=Array.isArray(source?.dependencies)?source.dependencies:[];
 if(source?.dependencyKind==='consumed-images-v1')return dependencies;
 const images=source?.conversionReport?.externalImages;
 if(!Array.isArray(images))return dependencies;
 return dependencies.filter(dep=>images.some(image=>{
  const path=String(image.path||'').replaceAll('\\','/');
  return image.sha256===dep.sha256&&(image.projectRelativePath===dep.projectRelativePath||path===dep.projectRelativePath||path.endsWith('/'+dep.projectRelativePath));
 }));
}
export function sourceForTask(source){
 if(!source)return source;
 return {...source,...(Array.isArray(source.dependencies)?{dependencies:consumedDependencies(source),...(source.dependencyKind==='consumed-images-v1'||Array.isArray(source.conversionReport?.externalImages)?{dependencyKind:'consumed-images-v1'}:{})}:{})};
}
import {createHash} from 'node:crypto';

export function characterProfileDigest(value){
 const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
 return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function characterBindingDigest(profile){
 return characterProfileDigest(profile?{model:profile.model,animations:profile.animations||[],evidence:profile.evidence||[]}:null);
}
