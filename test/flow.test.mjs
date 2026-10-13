import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CodeTools } from '../src/code-tools.mjs';
import { Jobs } from '../src/jobs.mjs';
import { Traces } from '../src/trace.mjs';
import { createApp } from '../src/server.mjs';
import { validatePlan } from '../src/workspace.mjs';

async function setup(t,extra={}) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'core-flow-'));
  const config={workspace:path.join(dir,'work'),dataRoot:path.join(dir,'state'),bearerToken:'test-only',password:'test-admin',publicBaseURL:'',httpOrigins:[],...extra};
  await mkdir(config.workspace);await mkdir(config.dataRoot);
  t.after(()=>rm(dir,{force:true,recursive:true}));return config;
}
async function serve(t,config) {
  const app=await createApp(config);
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+app.server.address().port;
  t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));});
  const rpc=async(method,params={})=>{
    const response=await fetch(base+'/mcp',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer test-only'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
    assert.equal(response.status,200);const data=await response.json();assert.ok(!data.error,JSON.stringify(data));return data.result;
  };
  const call=(name,args={})=>rpc('tools/call',{name,arguments:args});
  return {app,base,rpc,call};
}
async function terminal(jobs,id){let state;for(let i=0;i<150;i++){state=await jobs.status(id);if(!['queued','running'].includes(state.status))return state;await delay(30);}throw new Error('Job still active');}

test('native file navigation, multilingual ranges, guarded continuation and literal search',async t=>{
  const c=await setup(t);const fs=new CodeTools(c);
  await mkdir(path.join(c.workspace,'src'));
  await writeFile(path.join(c.workspace,'src/main.txt'),'alpha\r\n\u4e2d\u6587 beta\r\nalpha beta\r\n');
  await writeFile(path.join(c.workspace,'.env'),'DO_NOT_LEAK');
  await mkdir(path.join(c.workspace,'node_modules'));
  await writeFile(path.join(c.workspace,'node_modules/skip.txt'),'alpha');
  const tree=await fs.list({depth:2,limit:1});assert.equal(tree.entries.length,1);assert.ok(tree.next_cursor);
  const next=await fs.list({depth:2,limit:1,cursor:tree.next_cursor});assert.equal(next.entries[0].path,'src/main.txt');
  const read=await fs.read({files:[{path:'src/main.txt',line_count:1},{path:'missing'}]});
  assert.match(read.files[0].numbered_text,/1: alpha/);assert.ok(read.files[1].error);
  const continuation=await fs.read({files:[read.files[0].next_read]});assert.match(continuation.files[0].numbered_text,/\u4e2d\u6587/);
  const found=await fs.search({query:'alpha',glob:'*.txt',limit:1});assert.equal(found.matches.length,1);assert.ok(found.next_cursor);
  const found2=await fs.search({query:'alpha',glob:'*.txt',limit:1,cursor:found.next_cursor});assert.equal(found2.matches[0].line,3);
  await assert.rejects(fs.search({query:'changed',cursor:found.next_cursor}),/cursor/);
  await writeFile(path.join(c.workspace,'src/main.txt'),'new content');
  const changed=await fs.read({files:[read.files[0].next_read]});assert.match(changed.files[0].error,/changed/);
});

test('native readers enforce private-state and link boundaries',async t=>{
  const c=await setup(t);const fs=new CodeTools(c);
  await writeFile(path.join(c.dataRoot,'secret'),'secret');await symlink(c.dataRoot,path.join(c.workspace,'escape'));
  await link(path.join(c.dataRoot,'secret'),path.join(c.workspace,'hard'));
  await assert.rejects(fs.list({path:'..'}));await assert.rejects(fs.read({files:[{path:'../state/secret'}]}));
  const blocked=await fs.read({files:[{path:'escape/secret'},{path:'hard'}]});assert.ok(blocked.files.every(x=>x.error));
  await mkdir(path.join(c.workspace,'private'));
  const other=new CodeTools({...c,dataRoot:path.join(c.workspace,'private')});await writeFile(path.join(c.workspace,'private/key'),'secret');
  const privateRead=await other.read({files:[{path:'private/key'}]});assert.match(privateRead.files[0].error,/private/);
  await writeFile(path.join(c.workspace,'large-line'),'x'.repeat(9000));
  const huge=await fs.read({files:[{path:'large-line'}],max_bytes:1024});assert.ok(huge.files[0].truncated);assert.ok(huge.files[0].error);assert.equal(huge.output_bytes,0);
});

test('job request_id survives recreation, reports same effects once, and short wait returns output',async t=>{
  const c=await setup(t);const jobs=new Jobs(c);await jobs.init();
  const args={command:'printf x >> count; printf "done\\n"',request_id:'single-change',wait_ms:3000};
  const a=await jobs.start(args);assert.equal(a.status,'succeeded');assert.equal(a.output,'done\n');
  const b=await new Jobs(c).start({...args,wait_ms:100});assert.equal(b.id,a.id);assert.equal(b.reused,true);
  assert.equal(await readFile(path.join(c.workspace,'count'),'utf8'),'x');
  await assert.rejects(jobs.start({...args,command:'printf different'}),/different arguments/);
  const long=await jobs.start({argv:[process.execPath,'-e','setTimeout(()=>console.log("late"),500)'],wait_ms:20});
  assert.ok(['queued','running'].includes(long.status));await terminal(jobs,long.id);
});

test('job incremental UTF-8 does not corrupt split multibyte characters and logs are capped',async t=>{
  const c=await setup(t);const jobs=new Jobs({...c,maxJobLogBytes:1024});await jobs.init();
  const job=await jobs.start({argv:[process.execPath,'-e','process.stdout.write("\u4e2d\u6587abc")'],wait_ms:3000});
  let offset=0,combined='';
  for(let i=0;i<12;i++){const read=await jobs.read({job_id:job.id,offset,max_bytes:1});combined+=read.output;offset=read.next_offset;if(!read.has_more)break;}
  assert.equal(combined,'\u4e2d\u6587abc');
  const loud=await jobs.start({argv:[process.execPath,'-e','process.stdout.write("x".repeat(16384))'],wait_ms:3000});
  assert.equal(loud.status,'succeeded');assert.equal(loud.log_truncated,true);assert.equal(loud.dropped_log_bytes,15360);
  assert.equal((await stat(path.join(jobs.directory(loud.id),'output.log'))).size,1024);
});

test('text-only upstream result remains text-only (trace metadata does not swallow output)',async t=>{
  const c=await setup(t);const traces=new Traces(c.dataRoot);await traces.init();
  const result=await traces.call('read_file','desktop_commander',async()=>({content:[{type:'text',text:'actual content'}]}));
  assert.equal(result.structuredContent,undefined);assert.equal(result.content[0].text,'actual content');assert.ok(result._meta['dev/trace_id']);
});

test('core catalog has sixteen tools, excludes DC, and preserves native file parameter annotation',async t=>{
  const c=await setup(t);const {app,rpc,call}=await serve(t,c);
  const catalog=await rpc('tools/list');assert.equal(catalog.tools.length,16);
  assert.equal(catalog.tools.find(x=>x.name==='file_import')._meta['openai/fileParams'][0],'file');
  assert.ok(catalog.tools.some(x=>x.name==='workspace_execute'));assert.ok(catalog.tools.some(x=>x.name==='fs_read'));
  assert.ok(!catalog.tools.some(x=>x.name==='set_config_value'));
  const guide=await call('dev_get_guide');assert.equal(guide.structuredContent.catalog.sha256,app.catalog().sha256);
});

test('disabled write/execute policies apply to both core batch operations and recovery semantics',async t=>{
  const c=await setup(t);const {app,call}=await serve(t,c);
  app.admin.settings.permissions.filesystemWrite=false;
  assert.equal((await call('job_start',{argv:['true']})).isError,true);
  assert.equal((await call('workspace_execute',{steps:[{type:'write',path:'blocked',content:'x'}]})).isError,true);
  assert.equal((await call('file_import',{file:{}})).isError,true);
  app.admin.settings.permissions.jobs=false;app.admin.settings.permissions.workspace=false;
  assert.equal((await call('job_list')).isError,undefined);assert.equal((await call('workspace_list')).isError,undefined);
  assert.equal(app.admin.allowed('start_process'),false);
  app.admin.settings.toolProfile='interactive';
  app.admin.upstreamNames.add('start_process');assert.equal(app.admin.allowed('start_process'),false);
});

test('real no-DC workflow: inspect -> guarded batch edit -> tests -> git diff -> signed export',async t=>{
  const c=await setup(t);const {app,call}=await serve(t,c);
  const project=path.join(c.workspace,'project');await mkdir(project);
  await writeFile(path.join(project,'main.mjs'),'export const answer = 1;\n');
  const init=await app.jobs.start({cwd:'project',command:'git init -q && git add main.mjs && git -c user.name=Test -c user.email=test@local commit -qm base',wait_ms:5000});assert.equal(init.exit_code,0);
  const found=(await call('fs_search',{cwd:'project',query:'answer'})).structuredContent;assert.equal(found.matches.length,1);
  const current=(await call('fs_read',{cwd:'project',files:[{path:'main.mjs'}]})).structuredContent.files[0];
  const batch=await call('workspace_execute',{cwd:'project',request_id:'edit-test',wait_ms:5000,steps:[
    {type:'write',path:'main.mjs',content:'export const answer = 42;\n',expected_sha256:current.sha256},
    {type:'exec',argv:[process.execPath,'--input-type=module','-e','import {answer} from "./main.mjs"; if(answer!==42)process.exit(7);console.log("verified")']}
  ]});
  assert.equal(batch.isError,undefined,JSON.stringify(batch));assert.equal(batch.structuredContent.status,'succeeded');
  assert.equal(batch.structuredContent.steps[1].result.output,'verified\n');
  const review=(await call('workspace_review',{cwd:'project'})).structuredContent;assert.match(review.unstaged_diff,/answer = 42/);assert.equal(review.errors.length,0);
  const exported=await call('file_export',{path:'project',exclude:['.git']});assert.equal(exported.isError,undefined);assert.ok(exported.content.some(x=>x.type==='resource_link'));
  assert.equal((await app.files.artifact(exported.structuredContent.id)).mimeType,'application/zip');
});

test('known parallel file conflicts are rejected before effects; create_only cannot overwrite',async t=>{
  assert.throws(()=>validatePlan({steps:[{id:'a',type:'write',path:'same',content:'a',depends_on:[]},{id:'b',type:'write',path:'same',content:'b',depends_on:[]}]}),/conflict/);
  assert.doesNotThrow(()=>validatePlan({steps:[{id:'a',type:'write',path:'same',content:'a'},{id:'b',type:'write',path:'same',content:'b',depends_on:['a']}]}));
  const c=await setup(t);const {call}=await serve(t,c);
  await writeFile(path.join(c.workspace,'existing'),'keep');
  const result=await call('workspace_execute',{steps:[{type:'write',path:'existing',content:'destroy',create_only:true}],wait_ms:3000});
  assert.equal(result.structuredContent.status,'failed');assert.equal(await readFile(path.join(c.workspace,'existing'),'utf8'),'keep');
});

test('concurrent repeated jobs and batches produce effects once across managers',async t=>{
  const c=await setup(t);const {app}=await serve(t,c);
  const another=new Jobs(c);await another.init();
  const args={argv:[process.execPath,'-e','require("fs").appendFileSync("count","x")'],request_id:'race',wait_ms:3000};
  const jobs=await Promise.all([app.jobs.start(args),another.start(args)]);
  assert.equal(jobs[0].id,jobs[1].id);assert.equal(await readFile(path.join(c.workspace,'count'),'utf8'),'x');
  const {Workspace}=await import('../src/workspace.mjs');const second=new Workspace(c,another);await second.init();
  const plan={request_id:'batch-race',wait_ms:4000,steps:[{type:'exec',command:'printf x >> batch-count'}]};
  const [a,b]=await Promise.all([app.workspaceBatches.execute(plan),second.execute(plan)]);
  assert.equal(a.execution_id,b.execution_id);assert.equal(await readFile(path.join(c.workspace,'batch-count'),'utf8'),'x');
});

test('a failed optional upstream does not block core file tools or remove saved blocked tool names',async t=>{
  const c=await setup(t,{upstreamArgv:['/nonexistent/mcp-optional-upstream']});
  const {app,call}=await serve(t,c);
  assert.equal(app.upstream.status().connected,false);
  assert.equal((await call('fs_list')).isError,undefined);
  const {validateAdminSettings,defaultAdminSettings}=await import('../src/admin.mjs');
  const settings=defaultAdminSettings(c);settings.blockedTools=['set_config_value'];
  assert.doesNotThrow(()=>validateAdminSettings(settings,new Set(app.tools.map(t=>t.name))));
});

test('optional upstream reconnects after exit without replaying a command',async t=>{
  const c=await setup(t);const stub=path.join(c.workspace,'stub.cjs');
  await writeFile(stub,`const readline=require('node:readline');
    readline.createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id===undefined)return;
    let result=m.method==='initialize'?{capabilities:{tools:{}}}:m.method==='tools/list'?{tools:[{name:'dc_probe',inputSchema:{type:'object',properties:{}}}]}:{content:[{type:'text',text:'once'}]};
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
  const {ManagedUpstream}=await import('../src/managed-upstream.mjs');const bridge=new ManagedUpstream([process.execPath,stub],c);
  t.after(()=>bridge.close());await bridge.init();assert.equal(bridge.status().connected,true);
  const first=bridge.client.process.pid;bridge.client.process.kill('SIGTERM');
  for(let i=0;i<100;i++){await delay(50);if(bridge.ready&&bridge.client.process.pid!==first)break;}
  assert.equal(bridge.ready,true);assert.notEqual(bridge.client.process.pid,first);
  const result=await bridge.request('tools/call',{name:'dc_probe',arguments:{}});assert.equal(result.content[0].text,'once');
});

test('core/interactive/legacy profiles share discovery and execution policy',async t=>{
  const c=await setup(t);const {app,call}=await serve(t,c);
  const names=['start_process','read_process_output','interact_with_process','force_terminate','list_sessions','write_file','set_config_value','get_prompts'];
  for(const name of names){app.tools.push({name,inputSchema:{type:'object',properties:{}}});app.admin.names.add(name);app.admin.upstreamNames.add(name);}
  assert.equal(app.catalog().visible_count,16);const hash=app.catalog().sha256;
  app.admin.settings.toolProfile='interactive';assert.equal(app.catalog().visible_count,21);
  assert.equal(app.admin.allowed('set_config_value'),false);assert.equal(app.admin.allowed('write_file'),false);
  app.admin.settings.toolProfile='legacy';assert.equal(app.catalog().visible_count,24);assert.notEqual(app.catalog().sha256,hash);
  app.admin.settings.permissions.filesystemWrite=false;
  assert.equal(app.admin.allowed('write_file'),false);assert.equal(app.admin.allowed('start_process'),false);assert.equal(app.admin.allowed('read_process_output'),true);
  app.admin.settings.limits.callsPerMinute=1;app.admin.callTimes=[Date.now()];
  assert.equal((await call('job_list')).isError,undefined);
  assert.equal((await call('fs_list')).isError,true);
});

test('batch private-state writes are rejected and no-Git review does not initialize a repository',async t=>{
  const c=await setup(t);c.dataRoot=path.join(c.workspace,'private');await mkdir(c.dataRoot);
  const {app,call}=await serve(t,c);
  const blocked=await call('workspace_execute',{steps:[{type:'write',path:'private/config',content:'x'}]});
  assert.equal(blocked.isError,true);assert.match(blocked.structuredContent.error.message,/private/);
  const review=(await call('workspace_review')).structuredContent;assert.equal(review.git_available,false);
  await assert.rejects(stat(path.join(c.workspace,'.git')));
  app.admin.settings.limits.maxJobSeconds=30;
  const bounded=app.admin.enforce('workspace_execute',{steps:[{type:'container_build'}]});
  assert.equal(bounded.steps[0].timeout_seconds,30);
});

test('ambiguous job launch reservation is not replayed and settings limits remain strict',async t=>{
  const c=await setup(t);const jobs=new Jobs(c);await jobs.init();
  await assert.rejects(jobs.start({argv:[],request_id:'invalid-reservation'}),/argv/);
  await assert.rejects(jobs.start({argv:[],request_id:'invalid-reservation'}),/reservation/);
  const {defaultAdminSettings,validateAdminSettings}=await import('../src/admin.mjs');
  const defaults=defaultAdminSettings(c);const invalid=structuredClone(defaults);delete invalid.oauth.accessTokenMinutes;
  assert.throws(()=>validateAdminSettings(invalid,new Set()),/OAuth/);
  invalid.oauth=defaults.oauth;invalid.security={other:30};assert.throws(()=>validateAdminSettings(invalid,new Set()),/session/);
});

test('deployment helper checks conflicts before replacement and restores original modes',async t=>{
  const c=await setup(t);const script=path.resolve('scripts/deploy_files.py');
  const source=path.join(c.workspace,'release'),target=path.join(c.workspace,'live'),backup=path.join(c.workspace,'backup');
  await mkdir(path.join(source,'src'),{recursive:true});await mkdir(path.join(source,'web'));await mkdir(path.join(target,'src'),{recursive:true});await mkdir(path.join(target,'web'));
  const hash=x=>createHash('sha256').update(x).digest('hex');
  await writeFile(path.join(source,'src/server.mjs'),'new');await writeFile(path.join(target,'src/server.mjs'),'old',{mode:0o640});
  await writeFile(path.join(source,'RELEASE.json'),JSON.stringify({files:{'src/server.mjs':hash('new')}}));
  await writeFile(path.join(source,'BASELINE.json'),JSON.stringify({hashes:{'src/server.mjs':hash('old')}}));
  async function command(args){return await new Promise((resolve,reject)=>{const p=spawn('python3',[script,...args],{stdio:'ignore'});p.once('error',reject);p.once('exit',resolve);});}
  assert.equal(await command(['apply',source,target,backup]),0);assert.equal(await readFile(path.join(target,'src/server.mjs'),'utf8'),'new');
  assert.equal(await command(['rollback',target,backup]),0);assert.equal(await readFile(path.join(target,'src/server.mjs'),'utf8'),'old');assert.equal((await stat(path.join(target,'src/server.mjs'))).mode & 0o777,0o640);
  await writeFile(path.join(target,'src/server.mjs'),'unrelated-change');
  assert.notEqual(await command(['apply',source,target,path.join(c.workspace,'another-backup')]),0);
  assert.equal(await readFile(path.join(target,'src/server.mjs'),'utf8'),'unrelated-change');
});
