import {watch} from 'node:fs';
import {join} from 'node:path';

// A notification is only a hint. Read the locked workspace snapshot after
// every notification, so CLI writes and multi-file commits stay consistent.
export function createStudioEvents(work) {
 const clients=new Set();
 let root,jobs,timer,heartbeat;
 function changed(){
  if(!clients.size||timer)return;
  timer=setTimeout(()=>{
   timer=null;
   for(const res of clients)if(!res.write('event: studio\ndata: changed\n\n'))res.destroy();
  },35);
  timer.unref();
 }
 function watchPath(path,options,onChange){
  try{
   const watcher=watch(path,{persistent:false,...options},onChange);
   watcher.on('error',()=>watcher.close());
   return watcher;
  }catch{return null;} // The viewer keeps a polling fallback.
 }
 function watchJobs(){
  jobs?.close();
  jobs=watchPath(join(work,'jobs'),{recursive:true},(_,name)=>{
   if(!name||/^[a-f0-9-]{36}(?:[/\\]job\.json)?$/.test(String(name)))changed();
  });
 }
 function stop(){
  root?.close();jobs?.close();root=null;jobs=null;
  clearTimeout(timer);timer=null;clearInterval(heartbeat);heartbeat=null;
 }
 return {
  subscribe(res){
   if(!clients.size){
    root=watchPath(work,{},(_,name)=>{
     if(String(name)==='jobs')watchJobs();
     if(!name||['project.json','jobs'].includes(String(name)))changed();
    });
    watchJobs();
    heartbeat=setInterval(()=>{
     for(const client of clients)if(!client.write(': keepalive\n\n'))client.destroy();
    },15000);
    heartbeat.unref();
   }
   clients.add(res);
   res.once('close',()=>{clients.delete(res);if(!clients.size)stop();});
   res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
   res.write('retry: 2000\nevent: studio\ndata: ready\n\n');
  },
  changed,
  close(){for(const res of clients)res.end();clients.clear();stop();}
 };
}
