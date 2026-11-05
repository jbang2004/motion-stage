// Names are labels. The glTF node index identifies a joint within this asset.
export const jointIndex=(model,node)=>model.parser?.associations?.get(node)?.nodes;
export const jointName=(model,node)=>{const index=jointIndex(model,node);return index===undefined?node.name:model.parser.json.nodes[index]?.name||node.name;};
export function findJoint(model,name,index){
 if(!model)return null;
 if(Number.isInteger(index))return model.joints.find(node=>jointIndex(model,node)===index)||null;
 const matches=model.joints.filter(node=>jointName(model,node)===name||node.name===name);
 return matches.length===1?matches[0]:null;
}
export const jointValue=(model,node)=>{const index=jointIndex(model,node);return index===undefined?node.name:'node:'+index;};
export function selectedJoint(model,value){
 if(!model)return null;
 return /^node:\d+$/.test(value)?findJoint(model,null,Number(value.slice(5))):findJoint(model,value);
}

// Node indices cannot be carried blindly into a re-exported candidate file.
export function correspondingJoint(model,reference,target){
 if(!model||!target)return null;
 const from=reference?.parser?.json?.nodes,to=model.parser?.json?.nodes;
 const sameBytes=Boolean(model.meta?.sha256&&model.meta.sha256===reference?.meta?.sha256);
 const sameNodes=Array.isArray(from)&&Array.isArray(to)&&from.length===to.length&&from.every((node,i)=>JSON.stringify(node)===JSON.stringify(to[i]));
 return findJoint(model,target.bone,sameBytes||sameNodes?target.nodeIndex:undefined);
}
