// Repeatable loopback-only MCP benchmark: OFF, metadata-only, full payload capture.
// Never imports real credentials, touches production paths or changes services.
// Run: node scripts/benchmark-mcp.mjs [requests] (default 200).
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {createApp} from '../src/server.mjs';
const parsed=Number(process.argv[2]||200);
if(!Number.isSafeInteger(parsed)||parsed<20||parsed>5000)
  throw new Error('Usage: node scripts/benchmark-mcp.mjs [requests 20..5000]');
const root=await mkdtemp(path.join(os.tmpdir(),'scd-bench-'));
const workspace=path.join(root,'work'),dataRoot=path.join(root,'data');
await Promise.all([mkdir(workspace),mkdir(dataRoot)]);
const app=await createApp({workspace,dataRoot,bearerToken:'offline-loopback-benchmark'});
const server=app.server;
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port+'/mcp';
 const results=[];
 async function call(method){
   const payload={jsonrpc:'2.0',method,id:1,...(method==='tools/call'?{params:{name:'dev_get_guide',arguments:{}}}:{})};
   const start=performance.now();
   const response=await fetch(base,{method:'POST',headers:{
     'Authorization':'Bearer offline-loopback-benchmark',
     'Content-Type':'application/json'
   },body:JSON.stringify(payload)});
   const parsed=await response.json();
   if(!response.ok||parsed.error)throw new Error('Benchmark request failed');
   return performance.now()-start;
 }
 async function sample(label,method,enabled,captureContent){
   app.admin.performance.configure({enabled,captureContent,maxFileMB:4,
     maxContentFileMB:4,maxBodyKB:512,slowMs:250});
   app.admin.traces.configureDebug(enabled);
   for(let i=0;i<15;i++)await call(method);
   const timings=[];
   for(let i=0;i<parsed;i+=8){
     const batch=await Promise.all(Array.from({length:Math.min(8,parsed-i)},()=>call(method)));
     timings.push(...batch);
   }
   await app.admin.performance.flush();
   timings.sort((a,b)=>a-b);
   const pct=q=>Number(timings[Math.ceil(q*timings.length)-1].toFixed(3));
   results.push({label,method,enabled,captureContent,requests:parsed,p50_ms:pct(.50),
     p95_ms:pct(.95),p99_ms:pct(.99)});
 }
 for(const method of ['ping','tools/call']){
   await sample('off',method,false,false);
   await sample('metrics',method,true,false);
   await sample('full-payload',method,true,true);
 }
 console.log(JSON.stringify({benchmark:'localhost-HTTP-8-concurrency',results},null,2));
} finally{
 await new Promise(resolve=>server.close(resolve));
 await rm(root,{recursive:true,force:true});
}
