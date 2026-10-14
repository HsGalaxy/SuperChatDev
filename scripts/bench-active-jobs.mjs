// Reproducible, isolated disk-state benchmark. No privileged or production I/O.
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import os from 'node:os';
import path from 'node:path';
import {Jobs} from '../src/jobs.mjs';

const count=Math.max(100,Math.min(5000,Number(process.argv[2]||1500)));
const root=await mkdtemp(path.join(os.tmpdir(),'superchatdev-active-bench-'));
try {
  const workspace=path.join(root,'work'),dataRoot=path.join(root,'state'),jobRoot=path.join(dataRoot,'jobs');
  await mkdir(workspace);await mkdir(jobRoot,{recursive:true});
  const iso=new Date().toISOString();
  for(let i=0;i<count;i++){
    const id=randomUUID(),dir=path.join(jobRoot,id);
    await mkdir(dir);
    await writeFile(path.join(dir,'state.json'),JSON.stringify({id,status:'succeeded',created_at:iso,finished_at:iso}));
  }
  const jobs=new Jobs({workspace,dataRoot});
  const initial=performance.now();
  await jobs.init();
  const migration_ms=performance.now()-initial;
  const measure=async(fn,iterations)=>{
    const results=[];
    for(let i=0;i<iterations;i++){
      const start=performance.now();await fn();results.push(performance.now()-start);
    }
    results.sort((a,b)=>a-b);
    return Number(results[Math.floor(results.length/2)].toFixed(2));
  };
  const old_median_ms=await measure(()=>jobs.list(),5);
  const indexed_median_ms=await measure(()=>jobs.active(),15);
  console.log(JSON.stringify({historical_jobs:count,migration_ms:Number(migration_ms.toFixed(2)),
    historical_list_median_ms:old_median_ms,active_index_median_ms:indexed_median_ms,
    speedup_in_test:Number((old_median_ms/Math.max(0.001,indexed_median_ms)).toFixed(1)),
    note:'Isolated VPS filesystem benchmark; not end-to-end ChatGPT tool latency.'},null,2));
} finally {await rm(root,{recursive:true,force:true});}
