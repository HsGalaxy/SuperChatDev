// Optional isolated execution plane for SuperChatDev.
// The HTTP service never needs systemd privileges: it sends fixed, bounded
// operations to a sibling unprivileged systemd service over a 0600 Unix socket.
// Job details stay in existing durable state; there is no new task database.
import {createServer,connect} from 'node:net';
import {constants} from 'node:fs';
import {spawn} from 'node:child_process';
import {open,readFile,chmod,unlink,lstat,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {atomicJSON} from './common.mjs';
import {runnerSocket} from './runner-ipc.mjs';
import {executionEnvironment} from './environment.mjs';
import {processIdentity} from './jobs.mjs';
import {QuickExec} from './quick-exec.mjs';

const jobWorker=fileURLToPath(new URL('./job-worker.mjs',import.meta.url));
const batchWorker=fileURLToPath(new URL('./workspace-worker.mjs',import.meta.url));
const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REQUEST=64*1024;

export async function serveRunner({dataRoot,workspace,executionUid,executionGid,executionHome,executionEnv={},maxJobs=4,socketPath=runnerSocket(dataRoot)}){
 if(!path.isAbsolute(dataRoot)||!path.isAbsolute(workspace))throw Error('Runner requires absolute workspace and dataRoot');
 if(process.geteuid?.()===0)throw Error('Refusing to run the broker as root');
 if(process.platform!=='linux')throw Error('Isolated runner requires Linux');
 await mkdir(dataRoot,{recursive:true,mode:0o700});
 const listenSocket=path.resolve(socketPath);
 if(path.dirname(listenSocket)!==path.resolve(dataRoot))throw Error('Socket must reside in private state root');
 const environment={workspace,dataRoot,executionUid,executionGid,executionHome,executionEnv,maxJobs};
 const quick=new QuickExec(environment);
 let launches=0;
 const server=createServer(socket=>{
  let size=0,chunks=[],handled=false;
  socket.setTimeout(36000,()=>socket.destroy());
  socket.on('data',chunk=>{
   if(handled)return;
   size+=chunk.length;
   if(size>MAX_REQUEST){socket.end(JSON.stringify({ok:false,error:'Runner message exceeds limit'})+'\n');handled=true;return}
   chunks.push(chunk);
   const data=Buffer.concat(chunks),newline=data.indexOf(10);
   if(newline<0)return;
   handled=true;
   void (async()=>{
    try{
     const input=JSON.parse(data.subarray(0,newline).toString('utf8'));
     if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Invalid runner request');
     let result;
     if(input.op==='exec'){
      if(Object.keys(input).some(k=>!['op','params'].includes(k)))throw Error('Unknown runner execution field');
      result=await quick.run(input.params);
     }else if(['job','batch'].includes(input.op)){
      if(Object.keys(input).some(k=>!['op','id'].includes(k))||!idPattern.test(input.id||''))throw Error('Invalid runner job identifier');
      if(launches>=16)throw Error('Runner has too many concurrent job launch requests');
      launches++;
      try{
       const dir=path.join(dataRoot,input.op==='job'?'jobs':'batches',input.id);
       const fd=await open(path.join(dir,input.op==='job'?'spec.json':'plan.json'),constants.O_RDONLY|constants.O_NOFOLLOW);
       try{if(!(await fd.stat()).isFile())throw Error('Invalid runner job spec')}
       finally{await fd.close()}
       const extra=input.op==='batch'?
         {BATCH_CONFIG:await readFile(path.join(dir,'batch-runner-config.json'),'utf8')}:
         (executionUid!==undefined?{JOB_EXEC_UID:String(executionUid),JOB_EXEC_GID:String(executionGid)}:{});
       const child=spawn(process.execPath,[input.op==='job'?jobWorker:batchWorker,dir],{
        detached:true,stdio:'ignore',
        env:{...executionEnvironment(environment),...extra}
       });
       await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject)});
       const starttime=await processIdentity(child.pid);
       // Store ownership before replying. If the IPC acknowledgement is lost,
       // the existing request-id reservation and durable state remain usable.
       await atomicJSON(path.join(dir,'owner.json'),{pid:child.pid,starttime});
       child.unref();
       result={pid:child.pid,starttime};
      }finally{launches--}
     }else throw Error('Unknown isolated runner operation');
     socket.end(JSON.stringify({ok:true,result})+'\n');
    }catch(error){
     socket.end(JSON.stringify({ok:false,error:String(error.message).slice(0,400)})+'\n');
    }
   })();
  });
  socket.on('error',()=>{});
 });
 // Never remove an active or foreign socket. A previous crash can leave a
 // stale SOCK file that systemd must reclaim for a clean broker restart.
 try{
  const existing=await lstat(listenSocket);
  if(!existing.isSocket()||existing.uid!==process.geteuid())
    throw Error('Runner socket path is not an owned Unix socket');
  const state=await new Promise(resolve=>{
    const probe=connect(listenSocket);
    let done=false;
    const finish=value=>{if(done)return;done=true;probe.destroy();resolve(value)};
    probe.setTimeout(350,()=>finish('unknown'));
    probe.once('connect',()=>finish('active'));
    probe.once('error',e=>finish(e.code==='ECONNREFUSED'?'stale':'unknown'));
  });
  if(state!=='stale')throw Error('Runner socket is in use or cannot be verified');
  await unlink(listenSocket);
 }catch(e){if(e.code!=='ENOENT')throw e}
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(listenSocket,resolve)});
 await chmod(listenSocket,0o600);
 server.once('close',()=>{void unlink(listenSocket).catch(()=>{})});
 return server;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const opts=process.env;
  if(!opts.JOB_RUNNER_DATA_ROOT||!opts.JOB_RUNNER_WORKSPACE)throw Error('Runner has no private dataRoot/workspace');
  const config={
   dataRoot:opts.JOB_RUNNER_DATA_ROOT,workspace:opts.JOB_RUNNER_WORKSPACE,
   executionUid:opts.JOB_RUNNER_EXEC_UID?Number(opts.JOB_RUNNER_EXEC_UID):undefined,
   executionGid:opts.JOB_RUNNER_EXEC_GID?Number(opts.JOB_RUNNER_EXEC_GID):undefined,
   executionHome:opts.JOB_RUNNER_EXEC_HOME,
   executionEnv:opts.JOB_RUNNER_EXEC_ENV?JSON.parse(opts.JOB_RUNNER_EXEC_ENV):{},
  };
  if(config.executionUid!==undefined&&(!Number.isSafeInteger(config.executionUid)||!Number.isSafeInteger(config.executionGid)))
    throw Error('Runner execution identity is invalid');
  const server=await serveRunner(config);
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>server.close(()=>process.exit(0)));
  console.error('SuperChatDev isolated runner listening on private Unix socket');
 }catch(e){console.error(e.message);process.exitCode=1}
}
