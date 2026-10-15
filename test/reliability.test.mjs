import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Files} from '../src/files.mjs';
import {Jobs} from '../src/jobs.mjs';
import {Workspace} from '../src/workspace.mjs';
import {QuickExec} from '../src/quick-exec.mjs';
import {ManagedUpstream} from '../src/managed-upstream.mjs';
import {serveRunner} from '../src/isolated-runner.mjs';
import {createApp} from '../src/server.mjs';
import {spawnSync} from 'node:child_process';
import {runnerSocket,runnerRequest} from '../src/runner-ipc.mjs';
import {Traces} from '../src/trace.mjs';
import {resourceHealth} from '../src/resource-health.mjs';
import {summarizeExecutions} from '../src/execution-summary.mjs';

async function fixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'scd-reliability-'));
 const workspace=path.join(root,'workspace'),dataRoot=path.join(root,'state');
 await Promise.all([mkdir(workspace),mkdir(dataRoot)]);
 t.after(()=>rm(root,{recursive:true,force:true}));
 return {root,workspace,dataRoot};
}
const sleep=ms=>new Promise(ok=>setTimeout(ok,ms));
async function terminal(jobs,id,timeout=10000){
 const until=Date.now()+timeout;
 while(Date.now()<until){
  const state=await jobs.status(id);
  if(['succeeded','failed','cancelled','interrupted'].includes(state.status))return state;
  await sleep(35);
 }
 throw Error('job did not finish');
}

test('file exports advertise only readable resources, preserve signed HTTPS and expiry',async t=>{
 const c=await fixture(t);
 const files=new Files({...c,publicBaseURL:'https://mcp.test.example.net',maxFileBytes:1000,maxResourceBytes:8});
 await files.init();
 await writeFile(path.join(c.workspace,'small.txt'),'a\n');
 await writeFile(path.join(c.workspace,'large.txt'),'0123456789abcdef');
 const small=await files.exportFile({path:'small.txt',ttl_seconds:60});
 const big=await files.exportFile({path:'large.txt',ttl_seconds:60});
 assert.equal(small.structuredContent.resource_read_available,true);
 assert.equal(big.structuredContent.resource_read_available,false);
 assert.ok(small.content.find(x=>x.type==='resource_link'&&x.uri.startsWith('artifact:')));
 assert.equal(big.content.filter(x=>x.type==='resource_link').length,0);
 assert.ok(small.content[0].text.includes('https://mcp.test.example.net/artifacts/'));
 assert.ok(big.content[0].text.includes('https://mcp.test.example.net/artifacts/'));
 assert.ok(!small.content.some(x=>x.type==='resource_link'&&x.uri.startsWith('https://')));
 assert.deepEqual((await files.listResources()).resources.map(x=>x.name),['small.txt']);
 assert.equal(Buffer.from((await files.readResource(small.structuredContent.resource_uri)).contents[0].blob,'base64').toString(),'a\n');
 await assert.rejects(files.readResource(big.structuredContent.resource_uri),/too large/);
 const link=new URL(small.structuredContent.download_url);
 const id=link.pathname.split('/').at(-1);
 assert.equal((await files.downloadArtifact(id,link.searchParams.get('expires'),link.searchParams.get('token'))).name,'small.txt');
 await assert.rejects(files.downloadArtifact(id,'1',link.searchParams.get('token')),/expired/);
});

test('managed upstream cache-only init does not launch DC and pause drains in-flight calls',async t=>{
 const c=await fixture(t);
 const cache=path.join(c.dataRoot,'upstream-catalog.json');
 await writeFile(cache,JSON.stringify({version:1,tools:[{name:'read_file',inputSchema:{type:'object',properties:{}}}]}));
 let spawned=0;
 const upstream=new ManagedUpstream(['fake-dc'],{...c,upstreamSpawn:()=>{spawned++;throw Error('Unexpected DC spawn')}});
 await upstream.init({connect:false});
 assert.equal(spawned,0);
 assert.equal(upstream.tools.length,1);
 let closed=0;
 upstream.client={pending:new Map([['one',true]]),close:()=>{closed++}};
 upstream.ready=true;
 upstream.pause();
 assert.equal(upstream.status().state,'idle');
 assert.equal(upstream.ready,false);
 assert.equal(closed,0,'in-flight calls may finish');
 upstream.draining.values().next().value.pending.clear();
 await sleep(130);
 assert.equal(closed,1);
 upstream.close();
});

test('delta preview avoids the repeated log head and retains pagination/UTF-8',async t=>{
 const c=await fixture(t),jobs=new Jobs(c);
 await jobs.init();
 const command="process.stdout.write('头部-'+('a'.repeat(3000))+'\\n'+'尾部-'+'测试'.repeat(80))";
 const started=await jobs.start({argv:[process.execPath,'-e',command],wait_ms:0});
 const finished=await terminal(jobs,started.id);
 assert.equal(finished.status,'succeeded');
 const full=await jobs.read({job_id:started.id,offset:0,max_bytes:1024,preview_mode:'full'});
 const compact=await jobs.read({job_id:started.id,offset:0,max_bytes:1024,preview_mode:'delta'});
 assert.equal(compact.next_offset,full.next_offset);
 assert.equal(compact.has_more,full.has_more);
 assert.equal(compact.output,full.output);
 assert.equal(compact.preview_mode,'delta');
 assert.ok(compact.output_preview.length<full.output_preview.length);
 assert.ok(compact.output_preview.includes('尾部'));
 const noPreview=await jobs.read({job_id:started.id,max_bytes:1024,preview_mode:'none'});
 assert.equal(noPreview.output_preview,undefined);
 await assert.rejects(jobs.read({job_id:started.id,preview_mode:'unknown'}));
});

test('trace summary parses only requested record page and keeps full mode',async t=>{
 const c=await fixture(t),traces=new Traces(c.dataRoot);
 await traces.init();
 for(let i=0;i<18;i++){
  const id=String(i).padStart(8,'0')+'-1111-4111-8111-aaaaaaaaaaaa';
  await writeFile(path.join(traces.root,String(i).padStart(10,'0')+'-'+id+'.json'),
   JSON.stringify({trace_id:id,tool:'job_read',state:'succeeded'}));
 }
 const first=await traces.peek({limit:3});
 assert.equal(first.calls.length,3);
 assert.equal(first.retained_calls,18);
 assert.ok(first.next_cursor);
 assert.equal(first.counts_sample_only,true);
 const second=await traces.peek({limit:3,cursor:first.next_cursor});
 assert.equal(second.calls.length,3);
 assert.notEqual(first.calls[0].trace_id,second.calls[0].trace_id);
 const full=await traces.read({limit:4});
 assert.equal(full.retained_calls,18);
});

test('cgroup diagnostics keeps usage and cumulative limit events separate from OOM',async t=>{
 const c=await fixture(t);
 const proc=path.join(c.root,'cgroup');
 await writeFile(proc,'0::/service/test\n');
 const scope=path.join(c.root,'cg','service','test');
 await mkdir(scope,{recursive:true});
 const values={'pids.current':'220','pids.peak':'256','pids.max':'256','pids.events':'max 1576\n',
 'memory.current':'1832112128','memory.peak':'2150428672',
 'memory.max':'2147483648','memory.events':'max 36991\noom 0\noom_kill 0\n'};
 for(const [name,value] of Object.entries(values))await writeFile(path.join(scope,name),value);
 const result=await resourceHealth({root:path.join(c.root,'cg'),cgroupFile:proc});
 assert.equal(result.available,true);
 assert.equal(result.pids.events.max,1576);
 assert.equal(result.memory.events.max,36991);
 assert.equal(result.memory.events.oom_kill,0);
 assert.ok(result.warnings.includes('pids_limit_reached_in_history'));
 assert.ok(result.warnings.includes('memory_at_least_80_percent'));
});

test('execution success rate counts one durable job/batch ID, not a child for each batch step',()=>{
 const result=summarizeExecutions([
  {id:'a',status:'succeeded'},
  {id:'a',status:'succeeded'},
  {id:'child',batch_execution_id:'batch1',status:'failed'},
  {id:'b',status:'interrupted'},
  {id:'c',status:'failed'},
 ],[
  {execution_id:'batch1',status:'failed'},
  {execution_id:'batch1',status:'failed'},
 ]);
 assert.equal(result.states.succeeded,1);
 assert.equal(result.states.failed,2);
 assert.equal(result.states.interrupted,1);
 assert.equal(result.kinds.excluded_batch_child_jobs,1);
 assert.equal(result.terminal_total,4);
 assert.equal(result.execution_success_rate,25);
});

test('opt-in isolated Unix runner owns durable job, batch and quick execution',async t=>{
 const c=await fixture(t),socket=runnerSocket(c.dataRoot);
 const runner=await serveRunner(c);
 t.after(async()=>new Promise(ok=>runner.close(ok)));
 const jobs=new Jobs({...c,runnerSocket:socket});
 await jobs.init();
 const quick=new QuickExec({...c,runnerSocket:socket});
 const short=await quick.run({argv:[process.execPath,'-e','process.stdout.write("fast-isolated")']});
 assert.equal(short.status,'succeeded');
 assert.equal(short.output,'fast-isolated');
 const durable=await jobs.start({argv:[process.execPath,'-e','process.stdout.write("durable-isolated")'],wait_ms:0,request_id:'runner-once'});
 const result=await terminal(jobs,durable.id);
 assert.equal(result.status,'succeeded');
 assert.equal(result.id,durable.id);
 const output=await jobs.read({job_id:durable.id});
 assert.equal(output.output,'durable-isolated');
 const repeated=await jobs.start({argv:[process.execPath,'-e','process.stdout.write("durable-isolated")'],wait_ms:0,request_id:'runner-once'});
 assert.equal(repeated.id,durable.id);
 assert.equal(repeated.reused,true);
 const batch=new Workspace({...c,runnerSocket:socket},jobs);
 await batch.init();
 const started=await batch.execute({steps:[{type:'write',path:'hello.txt',content:'written-in-runner'}],
  wait_ms:6000,request_id:'batch-once'});
 assert.equal(started.status,'succeeded',JSON.stringify(started).slice(-1200));
 assert.equal(await readFile(path.join(c.workspace,'hello.txt'),'utf8'),'written-in-runner');
 assert.equal((await batch.execute({steps:[{type:'write',path:'hello.txt',content:'written-in-runner'}],
  request_id:'batch-once',wait_ms:1000})).execution_id,started.execution_id);
});

test('if isolated runner is absent, failed launch never silently spawns in the control process',async t=>{
 const c=await fixture(t),jobs=new Jobs({...c,runnerSocket:path.join(c.dataRoot,'missing.sock')});
 await jobs.init();
 await assert.rejects(jobs.start({argv:[process.execPath,'-e','process.stdout.write("side-effect")'],wait_ms:0,request_id:'uncertain'}),/unconfirmed/);
 const recent=await jobs.page({limit:5});
 assert.equal(recent.jobs.length,1);
 assert.equal(recent.jobs[0].status,'queued');
 await assert.rejects(jobs.start({argv:[process.execPath,'-e','process.stdout.write("changed")'],wait_ms:0,request_id:'uncertain'}),/different arguments/);
});

test('active runner socket is never overwritten and stale socket is safely recovered',async t=>{
 const c=await fixture(t);
 const socket=runnerSocket(c.dataRoot);
 const stale=spawnSync('python3',['-c',
  'import socket,sys;s=socket.socket(socket.AF_UNIX);s.bind(sys.argv[1]);s.close()',socket]);
 assert.equal(stale.status,0,stale.stderr?.toString());
 const current=await stat(socket);assert.ok(current.isSocket());
 const server=await serveRunner(c);
 t.after(async()=>new Promise(resolve=>server.close(resolve)));
 await assert.rejects(serveRunner(c),/socket is in use/);
 const direct=await runnerRequest(socket,{op:'exec',params:{argv:[process.execPath,'-e','process.stdout.write("alive")']}});
 assert.equal(direct.output,'alive');
});
test('the HTTP server never spawns DC while Core or Native is selected',async t=>{
 const c=await fixture(t);
 let count=0;
 const app=await createApp({...c,upstreamArgv:['/fake/dc'],
  upstreamSpawn:()=>{count++;throw Error('DC incorrectly spawned in Core')},toolProfile:'core'});
 t.after(()=>new Promise(resolve=>app.server.close(resolve)));
 assert.equal(count,0);
 assert.equal(app.upstream.status().state,'idle');
 // Native likewise does not require DC, even with an upstream argv supplied.
 const settings={...app.admin.settings,toolProfile:'native-interactive'};
 await app.admin.save(settings);
 assert.equal(count,0);
 assert.equal(app.upstream.status().state,'idle');
});
