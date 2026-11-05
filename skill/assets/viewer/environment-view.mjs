import {element as el} from './ui.mjs';

// Uses the actual renderer result. A server-side version probe cannot verify GPU,
// authentication, quota, or a successful future import.
export function createEnvironmentPanel({button,dialog,body,recheck,close,reload,loadReport,reloadPage=()=>location.reload()}){
 let report=null,graphics={status:'not-checked'},pending=null,warning='';
 const make=(tag,text,className)=>el(tag,text,className,body.ownerDocument);
 function draw(){
  const rows=[];
  function row(label,status,detail){const item=make('div',undefined,'environment-row');item.append(make('b',label),make('span',status));if(detail)item.append(make('small',detail));rows.push(item);}
  row('三维预览',graphics.status==='ready'?'WebGL2 可用':graphics.status==='error'?'不可用':'等待浏览器检查',graphics.error);
  if(report){
   row('Node.js',report.node.supported?report.node.version+' · 可用':'需要升级至 22 或更高版本');
   row('记录目录',report.workspace.status==='ready'?'可读写':'检查未通过',report.workspace.error);
   row('本地服务',report.server?.status==='ready'?'已启动':'尚未确认');
   for(const[name,label]of [['blender','FBX 导入'],['codex','Codex 自动修改']]){
    const p=report[name];
    if(p.status==='not-checked')row(label,'使用时检查',name==='blender'?'导入 FBX 时检查 Blender 4.2+。':'连接时检查 Codex CLI；不影响本地查看。');
    else if(p.supported)row(label,'程序可启动 · '+p.version,name==='blender'?'实际转换能力会在导入时确认。':'登录和额度会在实际任务中确认。');
    else row(label,'当前不可用',p.error);
   }
  }else row('启动检查','尚未读取');
  if(warning)rows.push(make('p',warning,'error-copy'));
  body.replaceChildren(...rows);reload.hidden=graphics.status!=='error';
  button.title=graphics.status==='error'?'三维预览不可用，查看环境检查':'查看启动检查和可选功能依赖';
 }
 function load(refresh){
  if(pending)return pending;
  warning='';draw();recheck.disabled=true;recheck.textContent='正在检查…';
  pending=Promise.resolve().then(()=>loadReport(refresh)).then(value=>{report=value;draw();}).catch(error=>{
   warning='环境检查未完成：'+error.message;draw();
  }).finally(()=>{pending=null;recheck.disabled=false;recheck.textContent='重新检查';});
  return pending;
 }
 button.onclick=()=>{draw();dialog.showModal();if(!report)return load(false);};
 recheck.onclick=()=>load(true);close.onclick=()=>dialog.close();reload.onclick=reloadPage;
 return {update(value){report=value;if(dialog.open)draw();},setGraphics(value){graphics=value;draw();}};
}
