// Export the rendered (3D) MotionStage icon for marketing use.
//
//   PLAYWRIGHT_DIR=/path/with/node_modules/playwright-core node tools/brand/export-icon.mjs
//
// The source (motionstage-icon-source.png) is a Codex image render whose own
// rounded tile has black corners. We scale it up slightly so that edge falls
// outside, clip it to a continuous-curvature squircle with real transparency,
// add a faint edge light, and write dist/brand/motionstage-icon-{1024,512,256}.png
// for store pages, social previews and decks. The app itself ships the vector
// icon from vector-icon.mjs. Needs a Chromium that playwright-core can launch
// (PW_EXE to pick one).
import {createRequire} from 'node:module';
import {readFileSync,mkdirSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE=dirname(fileURLToPath(import.meta.url)),ROOT=join(HERE,'..','..');
const DIST=join(ROOT,'dist/brand');
const require=createRequire(join(process.env.PLAYWRIGHT_DIR||ROOT,'package.json'));
const {chromium}=require('playwright-core');

// Superellipse (n=5) smoothed with Catmull-Rom: the same tile shape Apple-style icons use.
function squircle(size=1024,n=5,N=64){
 const f=v=>Math.round(v*10)/10,a=size/2,pts=[];
 for(let i=0;i<N;i++){const t=i/N*2*Math.PI,c=Math.cos(t),s=Math.sin(t);pts.push([a+a*Math.sign(c)*Math.abs(c)**(2/n),a+a*Math.sign(s)*Math.abs(s)**(2/n)]);}
 let d=`M${f(pts[0][0])} ${f(pts[0][1])}`;
 for(let i=0;i<N;i++){const p0=pts[(i-1+N)%N],p1=pts[i],p2=pts[(i+1)%N],p3=pts[(i+2)%N];
  d+=`C${f(p1[0]+(p2[0]-p0[0])/6)} ${f(p1[1]+(p2[1]-p0[1])/6)} ${f(p2[0]-(p3[0]-p1[0])/6)} ${f(p2[1]-(p3[1]-p1[1])/6)} ${f(p2[0])} ${f(p2[1])}`;}
 return d+'Z';
}

const INSET=.022,art='data:image/png;base64,'+readFileSync(join(HERE,'motionstage-icon-source.png')).toString('base64');
const tile=squircle(),s=1024*(1+2*INSET),o=-1024*INSET;
const svg=size=>`<svg width="${size}" height="${size}" viewBox="0 0 1024 1024"><defs><clipPath id="c"><path d="${tile}"/></clipPath></defs><g clip-path="url(#c)"><image href="${art}" x="${o}" y="${o}" width="${s}" height="${s}" preserveAspectRatio="xMidYMid slice"/></g><path d="${tile}" fill="none" stroke="#fff" stroke-opacity=".10" stroke-width="5"/></svg>`;

mkdirSync(DIST,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.PW_EXE||undefined});
const render=async(size,file)=>{const page=await browser.newPage({viewport:{width:size,height:size}});await page.setContent(`<style>html,body{margin:0;background:transparent}</style>${svg(size)}`);await page.waitForTimeout(150);await page.screenshot({path:file,omitBackground:true});await page.close();};
for(const size of [1024,512,256])await render(size,join(DIST,`motionstage-icon-${size}.png`));
await browser.close();
console.log('exported dist/brand/motionstage-icon-{1024,512,256}.png');
