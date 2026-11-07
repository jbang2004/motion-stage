import test from 'node:test';
import assert from 'node:assert/strict';
import {jobAncestors} from '../job-lineage.mjs';
const row=(id,assetId,input,output,at,parentJobId)=>({id,assetId,slot:'candidate',state:'complete',createdAt:at,candidate:{sha256:output},inputs:{candidate:{sha256:input}},parentJobId});
test('lineage uses explicit task events and cannot cross assets with identical bytes',()=>{
 const a=row('a','hero','0','A','1'),b=row('b','hero','A','B','2','a'),c=row('c','hero','B','A','3','b'),other=row('o','other','x','A','0');
 assert.deepEqual([...jobAncestors([other,a,b,c],c)],['b','a']);assert.deepEqual([...jobAncestors([other,a,b,c],a)],[]);
});
test('ambiguous legacy ownership and invalid explicit parents do not invent ancestry',()=>{
 const a=row('a','hero','0','A','1'),b=row('b','hero','0','A','2'),c=row('c','hero','A','B','3');
 assert.equal(jobAncestors([a,b,c],c).size,0);c.parentJobId='a';assert.deepEqual([...jobAncestors([a,b,c],c)],['a']);c.parentJobId='missing';assert.equal(jobAncestors([a,b,c],c).size,0);
});
