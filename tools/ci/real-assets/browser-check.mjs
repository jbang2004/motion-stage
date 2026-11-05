// Invoked by the existing remote CI browser runner with its authorized context.
import assert from 'node:assert/strict';import{writeFile}from'node:fs/promises';import{join}from'node:path';import{serveRealAssets}from'./serve.mjs';
export async function checkRealAssetBrowser({context,skillRoot,samples,output}){
 const server=await serveRealAssets({skillRoot,samples}),page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});page.on('requestfailed',request=>errors.push(request.url()+': '+request.failure()?.errorText));page.on('response',response=>{if(response.status()>=400)errors.push(response.url()+': HTTP '+response.status());});
 try{await page.goto('http://127.0.0.1:'+server.address().port);await page.locator('#run').click();await page.waitForFunction(()=>/^(PASS|FAIL) ·/.test(document.getElementById('summary').textContent),null,{timeout:240000});const report=JSON.parse(await page.locator('#details').textContent());await writeFile(join(output,'real-assets-browser.json'),JSON.stringify({...report,errors},null,2));assert.equal(report.status,'PASS');assert.equal(report.cases.length,7);assert.ok(report.cases.every(c=>c.indexedJointSelection));assert.deepEqual(errors,[]);await page.screenshot({path:join(output,'real-assets-browser.png'),fullPage:false});return report;
 }finally{await page.close();await new Promise(resolve=>server.close(resolve));}
}
