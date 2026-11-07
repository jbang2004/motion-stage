// MotionStage app icon, drawn as vectors: `node tools/brand/vector-icon.mjs`
//
// An artist's mannequin leaps toward a stage, trailed by two glass onion-skin
// frames that shift from blue-violet to magenta as time moves forward. The
// figure is built from a real skeleton: every limb is a tapered capsule between
// two joints, so the ghosts are the same rig and the pose can be re-posed.
//
// Writes skill/assets/viewer/app-icon.svg (full detail, ≥ 48 px) and
// skill/assets/viewer/favicon.svg (no filters, bolder, ≤ 32 px).
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const VIEWER=new URL('../../skill/assets/viewer/',import.meta.url);
const f=v=>Math.round(v*10)/10;

export function squircle(size=1024,n=5,N=64){
 const a=size/2,pts=[];
 for(let i=0;i<N;i++){const t=i/N*2*Math.PI,c=Math.cos(t),s=Math.sin(t);pts.push([a+a*Math.sign(c)*Math.abs(c)**(2/n),a+a*Math.sign(s)*Math.abs(s)**(2/n)]);}
 let d=`M${f(pts[0][0])} ${f(pts[0][1])}`;
 for(let i=0;i<N;i++){const p0=pts[(i-1+N)%N],p1=pts[i],p2=pts[(i+1)%N],p3=pts[(i+2)%N];
  d+=`C${f(p1[0]+(p2[0]-p0[0])/6)} ${f(p1[1]+(p2[1]-p0[1])/6)} ${f(p2[0]-(p3[0]-p1[0])/6)} ${f(p2[1]-(p3[1]-p1[1])/6)} ${f(p2[0])} ${f(p2[1])}`;}
 return d+'Z';
}

// Tapered capsule: two circles joined by their outer tangents.
function capsule([ax,ay],r1,[bx,by],r2){
 const dx=bx-ax,dy=by-ay,L=Math.hypot(dx,dy),ux=dx/L,uy=dy/L,nx=-uy,ny=ux,c=(r1-r2)/L,s=Math.sqrt(Math.max(0,1-c*c));
 const p=(x,y,r,k)=>[x+r*(ux*c+nx*s*k),y+r*(uy*c+ny*s*k)];
 const a1=p(ax,ay,r1,1),b1=p(bx,by,r2,1),b2=p(bx,by,r2,-1),a2=p(ax,ay,r1,-1);
 return `M${f(a1[0])} ${f(a1[1])}L${f(b1[0])} ${f(b1[1])}A${f(r2)} ${f(r2)} 0 0 0 ${f(b2[0])} ${f(b2[1])}L${f(a2[0])} ${f(a2[1])}A${f(r1)} ${f(r1)} 0 0 0 ${f(a1[0])} ${f(a1[1])}Z`;
}
const circle=([x,y],r)=>`M${f(x-r)} ${f(y)}a${f(r)} ${f(r)} 0 1 0 ${f(2*r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2*r)} 0Z`;
function ellipse([x,y],rx,ry,deg=0){
 const t=deg*Math.PI/180,c=Math.cos(t),s=Math.sin(t),P=(u,v)=>[x+u*c-v*s,y+u*s+v*c],a=P(-rx,0),b=P(rx,0);
 return `M${f(a[0])} ${f(a[1])}A${f(rx)} ${f(ry)} ${deg} 1 0 ${f(b[0])} ${f(b[1])}A${f(rx)} ${f(ry)} ${deg} 1 0 ${f(a[0])} ${f(a[1])}Z`;
}

// Lead pose, measured on the approved render (1024 px space).
const POSE={
 head:[632,240],neck:[618,338],chest:[598,404],waist:[566,487],pelvis:[552,540],
 shoulderF:[646,366],elbowF:[757,362],wristF:[820,292],fistF:[843,262],
 shoulderB:[546,352],elbowB:[470,357],wristB:[405,404],fistB:[378,436],
 hipF:[588,540],kneeF:[716,527],ankleF:[812,600],heelF:[834,632],toeF:[877,567],
 hipB:[536,570],kneeB:[454,655],ankleB:[346,704],heelB:[334,702],toeB:[293,762]
};

// Parts back to front: limbs are tapered capsules, balls are joints/fists,
// shells are the head, rib cage and pelvis.
function figure(P){
 const L=(a,r1,b,r2)=>({type:'limb',a:P[a],r1,b:P[b],r2,d:capsule(P[a],r1,P[b],r2)});
 const B=(c,r,joint=true)=>({type:'ball',c:P[c],r,joint,d:circle(P[c],r)});
 const S=(c,rx,ry,deg)=>({type:'shell',d:ellipse(P[c],rx,ry,deg)});
 return [
  L('shoulderB',27,'elbowB',22),L('elbowB',22,'wristB',19),B('elbowB',23),B('wristB',18),B('fistB',29,false),
  L('hipB',44,'kneeB',31),L('kneeB',30,'ankleB',22),B('kneeB',31),L('heelB',28,'toeB',26),B('ankleB',21),
  S('pelvis',72,54,-15),B('waist',33),
  L('neck',17,'head',15),
  {type:'limb',a:[606,370],r1:63,b:[574,452],r2:41,d:capsule([606,370],63,[574,452],41)},B('shoulderB',23),
  L('hipF',46,'kneeF',33),L('kneeF',31,'ankleF',23),B('kneeF',32),L('heelF',36,'toeF',32),B('ankleF',22),
  L('shoulderF',28,'elbowF',23),L('elbowF',23,'wristF',19),B('elbowF',24),B('fistF',32,false),B('wristF',18),B('shoulderF',24),
  S('head',87,84,-8)
 ];
}
// Cylinder shading across each limb, lit from the upper right.
function limbGradient(id,{a,b,r1,r2}){
 const mx=(a[0]+b[0])/2,my=(a[1]+b[1])/2,dx=b[0]-a[0],dy=b[1]-a[1],l=Math.hypot(dx,dy);let nx=-dy/l,ny=dx/l;
 if(nx*.72-ny*.69<0){nx=-nx;ny=-ny;}const r=Math.max(r1,r2);
 return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${f(mx+nx*r)}" y1="${f(my+ny*r)}" x2="${f(mx-nx*r)}" y2="${f(my-ny*r)}"><stop offset="0" stop-color="#fffdfb"/><stop offset=".28" stop-color="#f7efec"/><stop offset=".7" stop-color="#d8c3ce"/><stop offset="1" stop-color="#a985ab"/></linearGradient>`;
}
const place=(x,y,s)=>`translate(${f(x)} ${f(y)}) scale(${s}) translate(${-POSE.head[0]} ${-POSE.head[1]})`;

export function iconSvg({small=false}={}){
 const SQ=squircle(),parts=figure(POSE),all=parts.map(p=>p.d).join('');
 const limbDefs=parts.map((p,i)=>p.type==='limb'?limbGradient('ms-l'+i,p):'').join('');
 const lead=parts.map((p,i)=>`<path d="${p.d}" fill="url(#${p.type==='limb'?'ms-l'+i:'ms-skin'})"${p.joint?' stroke="#8d6f8f" stroke-opacity=".22" stroke-width="2"':''}/>`).join('');
 const glassParts=parts.filter(p=>!p.joint);
 const ghost=(id,x,y,s,op)=>`<g transform="${place(x,y,s)}" opacity="${op}">${small?'':`<path d="${all}" fill="url(#ms-${id})" filter="url(#ms-glow)" opacity=".9"/>`}${glassParts.map(p=>`<path d="${p.d}" fill="url(#ms-${id})"${small?'':` stroke="url(#ms-${id}-edge)" stroke-width="${f(3.5/s)}" stroke-opacity=".8"`}/>`).join('')}</g>`;
 const glowDefs=small?'':`
<filter id="ms-glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="14"/></filter>
<filter id="ms-rim" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="1.4"/></filter>
<filter id="ms-blur" x="-50%" y="-300%" width="200%" height="700%"><feGaussianBlur stdDeviation="10"/></filter>`;
 return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<title>动作台 MotionStage</title>
<defs>
<linearGradient id="ms-bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2c15b0"/><stop offset=".5" stop-color="#1d0c80"/><stop offset="1" stop-color="#110551"/></linearGradient>
<radialGradient id="ms-spot" cx=".5" cy="-.02" r=".5"><stop offset="0" stop-color="#e2b4ff"/><stop offset=".22" stop-color="#a467ff" stop-opacity=".6"/><stop offset=".6" stop-color="#7a45ff" stop-opacity=".14"/><stop offset="1" stop-color="#8a55ff" stop-opacity="0"/></radialGradient>
<radialGradient id="ms-vignette" cx=".5" cy=".46" r=".72"><stop offset=".55" stop-color="#07021f" stop-opacity="0"/><stop offset="1" stop-color="#07021f" stop-opacity=".55"/></radialGradient>
<radialGradient id="ms-floor" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#ff8a3c" stop-opacity=".42"/><stop offset=".6" stop-color="#d0408f" stop-opacity=".12"/><stop offset="1" stop-color="#d0408f" stop-opacity="0"/></radialGradient>
<radialGradient id="ms-skin" cx=".68" cy=".24" r=".95"><stop offset="0" stop-color="#fffdfb"/><stop offset=".42" stop-color="#f4eae7"/><stop offset=".78" stop-color="#d4bccb"/><stop offset="1" stop-color="#a682a8"/></radialGradient>
<radialGradient id="ms-head-shade" cx=".72" cy=".22" r=".95"><stop offset=".55" stop-color="#5a2488" stop-opacity="0"/><stop offset="1" stop-color="#5a2488" stop-opacity=".32"/></radialGradient>
<linearGradient id="ms-shade" gradientUnits="userSpaceOnUse" x1="780" y1="230" x2="360" y2="760"><stop offset=".3" stop-color="#4a1a7a" stop-opacity="0"/><stop offset="1" stop-color="#4a1a7a" stop-opacity=".36"/></linearGradient>
<radialGradient id="ms-magenta" cx=".6" cy=".3" r=".95"><stop offset="0" stop-color="#f592ff"/><stop offset=".5" stop-color="#d044e6"/><stop offset="1" stop-color="#9a1fc4"/></radialGradient>
<linearGradient id="ms-magenta-edge" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffc4ff" stop-opacity=".85"/><stop offset="1" stop-color="#ff7ae6" stop-opacity=".35"/></linearGradient>
<radialGradient id="ms-violet" cx=".6" cy=".3" r=".95"><stop offset="0" stop-color="#9a94ff"/><stop offset=".5" stop-color="#5248ff"/><stop offset="1" stop-color="#3322d0"/></radialGradient>
<linearGradient id="ms-violet-edge" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c9c6ff" stop-opacity=".85"/><stop offset="1" stop-color="#8a84ff" stop-opacity=".35"/></linearGradient>
<linearGradient id="ms-rim-light" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd2a8"/><stop offset="1" stop-color="#ff8a3c"/></linearGradient>
<linearGradient id="ms-disc" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a98cff" stop-opacity=".22"/><stop offset=".7" stop-color="#5a2bc0" stop-opacity=".35"/><stop offset="1" stop-color="#ff8a3c" stop-opacity=".25"/></linearGradient>
<linearGradient id="ms-disc-rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff9a52" stop-opacity=".55"/><stop offset=".55" stop-color="#ffb070"/><stop offset="1" stop-color="#ffd3a0"/></linearGradient>${glowDefs}
${limbDefs}
<clipPath id="ms-clip"><path d="${SQ}"/></clipPath>
</defs>
<g clip-path="url(#ms-clip)">
<rect width="1024" height="1024" fill="url(#ms-bg)"/>
<rect width="1024" height="1024" fill="url(#ms-spot)"/>
<ellipse cx="506" cy="858" rx="360" ry="92" fill="url(#ms-floor)"/>
<rect width="1024" height="1024" fill="url(#ms-vignette)"/>
${small?'':`<ellipse cx="502" cy="832" rx="300" ry="34" fill="none" stroke="#ff8a3c" stroke-width="18" stroke-opacity=".55" filter="url(#ms-blur)"/>`}
<ellipse cx="502" cy="838" rx="298" ry="33" fill="#140748"/>
<path d="M204 828V838A298 33 0 0 0 800 838V828Z" fill="#1b0b5c"/>
<ellipse cx="502" cy="828" rx="298" ry="33" fill="url(#ms-disc)"/>
${small?'':`<ellipse cx="300" cy="830" rx="46" ry="10" fill="#6a60ff" fill-opacity=".45" filter="url(#ms-blur)"/><ellipse cx="408" cy="828" rx="56" ry="12" fill="#e070ff" fill-opacity=".42" filter="url(#ms-blur)"/><ellipse cx="560" cy="828" rx="88" ry="14" fill="#ffd7c0" fill-opacity=".38" filter="url(#ms-blur)"/>`}
<ellipse cx="502" cy="828" rx="298" ry="33" fill="none" stroke="url(#ms-disc-rim)" stroke-width="${small?9:4}"/>
<path d="M204 829A298 33 0 0 0 800 829" fill="none" stroke="#ffc58a" stroke-width="${small?10:6}" stroke-linecap="round"/>
<path d="M210 840A296 33 0 0 0 794 840" fill="none" stroke="#ff8a3c" stroke-opacity=".75" stroke-width="3"/>
${ghost('violet',238,415,.49,small?.82:.78)}
${ghost('magenta',390,330,.64,small?.9:.86)}
${small?'':`<path d="${all}" fill="#ff8a3c" opacity=".2" filter="url(#ms-glow)"/>
<path d="${all}" fill="url(#ms-rim-light)" transform="translate(-5 4)" filter="url(#ms-rim)"/>`}
${lead}
<path d="${all}" fill="url(#ms-shade)"/>
<path d="${ellipse(POSE.head,87,84,-8)}" fill="url(#ms-head-shade)"/>
</g>
${small?'':`<path d="${SQ}" fill="none" stroke="#fff" stroke-opacity=".10" stroke-width="5"/>`}
</svg>
`;
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 writeFileSync(new URL('app-icon.svg',VIEWER),iconSvg());
 writeFileSync(new URL('favicon.svg',VIEWER),iconSvg({small:true}));
 console.log('wrote app-icon.svg and favicon.svg');
}
