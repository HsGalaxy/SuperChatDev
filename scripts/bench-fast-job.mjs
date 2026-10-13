import {performance} from 'node:perf_hooks';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Jobs} from '../src/jobs.mjs';
const root=await mkdtemp(path.join(os.tmpdir(),'core-fast-bench-'));
const workspace=path.join(root,'work'), dataRoot=path.join(root,'state');
await mkdir(workspace); await mkdir(dataRoot);
const jobs=new Jobs({workspace,dataRoot,maxJobs:4});await jobs.init();
const results=[];
try{
 for(const [name,wait] of [['old_immediate',0],['new_auto_500',undefined]]){
  for(let i=0;i<8;i++){
   const started=performance.now();
   const arg={argv:['/bin/sh','-c','printf fast-ok'],timeout_seconds:10};
   if(wait!==undefined)arg.wait_ms=wait;
   let job=await jobs.start(arg);
   const firstMs=Math.round(performance.now()-started);
   let calls=1;
   while(['queued','running'].includes(job.status)){
     calls++;
     job=await jobs.read({job_id:job.id,offset:0,wait_ms:2000});
   }
   if(job.exit_code!==0||job.output!=='fast-ok')throw new Error(JSON.stringify(job));
   results.push({name,first_ms:firstMs,total_ms:Math.round(performance.now()-started),calls,final_status:job.status});
  }
 }
 const summarize=items=>{const xs=[...items.map(v=>v.first_ms)].sort((a,b)=>a-b);return{samples:items.length,fast_single_call:items.filter(v=>v.calls===1).length,average_calls:items.reduce((a,b)=>a+b.calls,0)/items.length,first_call_median_ms:xs[Math.floor(xs.length/2)],mean_total_ms:Math.round(items.reduce((a,b)=>a+b.total_ms,0)/items.length)};};
 const output=Object.fromEntries([...new Set(results.map(x=>x.name))].map(n=>[n,summarize(results.filter(x=>x.name===n))]));
 console.log(JSON.stringify({bench:'local VPS node runtime, no ChatGPT transport RTT',output,details:results},null,2));
}finally{await rm(root,{recursive:true,force:true});}
