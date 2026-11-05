import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
const argv=process.argv.slice(2),option=name=>argv[argv.indexOf('--'+name)+1];
assert.ok(argv.includes('--package')&&argv.includes('--output'));
const skill=resolve(option('package')),output=resolve(option('output')),repetitions=argv.includes('--repetitions')?Number(option('repetitions')):20;
assert.ok(Number.isInteger(repetitions)&&repetitions>0&&repetitions<=50);
await mkdir(output,{recursive:true});
const result={platform:process.platform,node:process.version,repetitions,verdict:'PASS',runs:[]};
for(let i=0;i<repetitions;i++){
 const run=spawnSync(process.execPath,['--test','--test-name-pattern=many processes reclaim one dead owner',join(skill,'scripts/test/workspace-store.test.mjs')],{cwd:skill,encoding:'utf8',timeout:120000});
 const text=(run.stdout||'')+(run.stderr||'');await writeFile(join(output,`round-${i+1}.log`),text);
 const count=[...text.matchAll(/^(?:#|ℹ) pass (\d+)$/gm)].at(-1)?.[1];
 result.runs.push({round:i+1,exitCode:run.status,passed:Number(count||0)});
 if(run.status!==0||count!=='1'){result.verdict='FAIL';result.error=run.error?.message||'Native concurrent lock regression failed';process.exitCode=1;break;}
}
await writeFile(join(output,'lock-stress.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
