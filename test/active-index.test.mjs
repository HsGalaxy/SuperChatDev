import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,readdir,readFile,rm,writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Jobs } from '../src/jobs.mjs';

async function fixture(t) {
 const root=await mkdtemp(path.join(os.tmpdir(),'scd-active-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const workspace=path.join(root,'workspace'),dataRoot=path.join(root,'data');
 await mkdir(workspace);await mkdir(dataRoot);
 return {workspace,dataRoot};
}

test('existing pre-index job history migrates without counting finished jobs',async t=>{
 const c=await fixture(t);const dir=path.join(c.dataRoot,'jobs');
 await mkdir(dir);
 const now=new Date().toISOString();
 for(let i=0;i<420;i++){
   const id=randomUUID();const target=path.join(dir,id);await mkdir(target);
   await writeFile(path.join(target,'state.json'),JSON.stringify({id,status:'succeeded',created_at:now,finished_at:now}));
 }
 const activeID=randomUUID();
 await mkdir(path.join(dir,activeID));
 await writeFile(path.join(dir,activeID,'state.json'),JSON.stringify({id:activeID,status:'queued',created_at:now}));
 const jobs=new Jobs({...c,maxJobs:3});await jobs.init();
 assert.equal((await jobs.active()).length,1);
 assert.ok((await readdir(path.join(dir,'active'))).includes(activeID));
 assert.ok((await readdir(path.join(dir,'active'))).includes('.ready'));
 assert.equal((await jobs.list()).length,421);
 await writeFile(path.join(dir,activeID,'state.json'),JSON.stringify({id:activeID,status:'succeeded',created_at:now}));
 assert.equal((await jobs.active()).length,0);
 assert.equal((await readdir(path.join(dir,'active'))).filter(x=>x===activeID).length,0);
 const restarted=new Jobs({...c,maxJobs:3});await restarted.init();
 assert.equal((await restarted.active()).length,0);
});

test('cross-manager admission observes active markers and cleans them after job completion',async t=>{
 const c=await fixture(t);
 const a=new Jobs({...c,maxJobs:1});const b=new Jobs({...c,maxJobs:1});
 await a.init();await b.init();
 const slow=await a.start({argv:[process.execPath,'-e','setTimeout(()=>console.log("late"),1000)'],wait_ms:0});
 assert.equal((await b.active()).length,1);
 await assert.rejects(b.start({argv:['true'],wait_ms:0}),/Concurrent job limit reached/);
 await a.cancel({job_id:slow.id});
 for(let i=0;i<50&& (await a.active()).length;i++)await new Promise(resolve=>setTimeout(resolve,40));
 assert.equal((await b.active()).length,0);
 const next=await b.start({argv:[process.execPath,'-e','console.log("ok")'],wait_ms:3000});
 assert.equal(next.status,'succeeded',JSON.stringify(next));
});
