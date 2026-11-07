import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDemo} from '../practice.mjs';
import {parseGlb,encodeGlb,editGlb} from '../asset-tools.mjs';
import {compareCandidate} from '../candidate-diff.mjs';

test('reordered animation, channel, node and accessor indices do not create a false diff',async()=>{
 const input=await buildDemo(false),{doc,bin}=parseGlb(input);
 const flipNode=i=>doc.nodes.length-1-i,flipAccessor=i=>doc.accessors.length-1-i;
 doc.nodes.reverse();
 for(const node of doc.nodes)if(node.children)node.children=node.children.map(flipNode);
 for(const scene of doc.scenes)scene.nodes=scene.nodes.map(flipNode);
 doc.accessors.reverse();
 for(const clip of doc.animations.reverse()){
  clip.channels.reverse();
  for(const channel of clip.channels)channel.target.node=flipNode(channel.target.node);
  for(const sampler of clip.samplers){sampler.input=flipAccessor(sampler.input);sampler.output=flipAccessor(sampler.output);}
 }
 const diff=compareCandidate(input,encodeGlb(doc,bin),{clip:'Run',lockOtherClips:true});
 assert.deepEqual(diff.tracks,{unchanged:16,changed:0,added:0,removed:0,unverified:0});
 assert.equal(diff.protection,'verified');
});

test('an unreadable protected track is unverified, while confirmed out-of-scope additions are violations',async()=>{
 const input=await buildDemo(false),{doc,bin}=parseGlb(input),salute=doc.animations.find(a=>a.name==='Salute');
 const sampler=salute.samplers[salute.channels[0].sampler];
 doc.accessors.push({...doc.accessors[sampler.output],sparse:{}});
 sampler.output=doc.accessors.length-1;
 const uncertain=compareCandidate(input,encodeGlb(doc,bin),{clip:'Run',lockOtherClips:true});
 assert.equal(uncertain.protection,'unverified');
 assert.equal(uncertain.tracks.unverified,1);
 assert.equal(uncertain.outside,0);
 doc.animations.push({...salute,name:'New motion'});
 const added=compareCandidate(input,encodeGlb(doc,bin),{clip:'Run',lockOtherClips:true});
 assert.equal(added.protection,'violated');
 assert.equal(added.outside,1);
 assert.equal(added.clips.find(c=>c.name==='New motion').status,'added');
});

test('a follow-up reports changes against the previous candidate, including inserted times',async()=>{
 const base=await buildDemo(false);
 const previous=editGlb(base,{clip:'Run',bone:'LeftShoulder',factor:.7}).bytes;
 const next=editGlb(previous,{clip:'Run',bone:'RightShoulder',factor:.6,start:.123,end:.789}).bytes;
 const diff=compareCandidate(previous,next,{clip:'Run'});
 assert.deepEqual(diff.clips[0].rows,[{status:'changed',target:'RightShoulder',property:'rotation',fields:['time','values']}]);
 assert.equal(diff.tracks.unchanged,15);
});
