import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PerformanceLog,validatePerformance} from '../src/performance.mjs';
import {defaultAdminSettings,validateAdminSettings} from '../src/admin.mjs';
import {createApp} from '../src/server.mjs';

async function temp(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'scd-performance-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 return root;
}
test('diagnostics default off, admin settings migrate, and config ranges are checked',async t=>{
 const root=await temp(t);
 const log=new PerformanceLog(root);
 assert.equal(log.enabled(),false);
 log.capture({method:'tools/call',tool:'job_start',duration_ms:55});
 assert.deepEqual(await log.records(),[]);
 const original=defaultAdminSettings({});
 assert.equal(original.performance.enabled,false);
 delete original.performance;
 const upgraded=validateAdminSettings(original,new Set());
 assert.equal(upgraded.performance.enabled,false);
 for(const bad of [{enabled:'true'}, {enabled:true,maxFileMB:0}, {enabled:true,maxFileMB:33},
   {enabled:true,slowMs:-1}, {enabled:true,slowMs:60001}, {enabled:true,secret:'not accepted'}]){
   assert.throws(()=>validatePerformance(bad));
 }
});
test('bounded JSONL logs redact arbitrary request objects and support rotation/clear',async t=>{
 const root=await temp(t),log=new PerformanceLog(root);
 log.configure({enabled:true,maxFileMB:1,slowMs:20});
 const SECRET='UNIQUE-SECRET-NEVER-LEAK-92671';
 log.capture({method:'tools/call',tool:'fs_read',status:200,tool_error:1,
   request_bytes:111,response_bytes:999,duration_ms:21,read_body_ms:1,parse_ms:2,dispatch_ms:17,
   argv:['bash','-c',SECRET],password:SECRET,headers:{authorization:SECRET},
   url:'https://example.test/?token='+SECRET});
 await log.flush();
 const raw=(await log.download()).toString();
 assert.ok(raw.includes('"tool":"fs_read"'));
 assert.ok(raw.includes('"tool_error":true'));
 assert.ok(!raw.includes(SECRET));
 const before=await log.summary();
 assert.equal(before.tools[0].errors,1);
 assert.equal(before.p50_ms,21);
 // Simulate near-cap log; next append must rotate and preserve bounded size.
 const filename=path.join(root,'mcp-performance.jsonl');
 await log.flush();
 await writeFile(filename,'\n'.repeat(1024*1024-1));
 log.size=null;
 log.capture({method:'ping',duration_ms:33,status:200});
 await log.flush();
 const old=await stat(filename+'.1');
 assert.ok(old.size<=1024*1024);
 const sample=await log.summary();
 assert.equal(sample.entries[0].method,'ping');
 await log.clear();
 assert.equal((await log.download()).byteLength,0);
});
test('Admin debug mode collects only structural RPC telemetry, supports timeline, live toggle and download',async t=>{
 const root=await temp(t),workspace=path.join(root,'work'),dataRoot=path.join(root,'state');
 await mkdir(workspace);await mkdir(dataRoot);
 const config={workspace,dataRoot,password:'ADMIN-PASSWORD-NOT-IN-LOG',bearerToken:'SENSITIVE-MCP-BEARER-NOT-IN-LOG',
  publicBaseURL:'https://test.invalid',httpOrigins:['https://test.invalid']};
 const app=await createApp(config);
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>app.server.close(resolve)));
 const base='http://127.0.0.1:'+app.server.address().port;
 const call=async(route,method='GET',payload,headers={})=>{
  const r=await fetch(base+route,{method,headers:{...headers,...(payload===undefined?{}:{'Content-Type':'application/json'})},
   ...(payload===undefined?{}:{body:JSON.stringify(payload)})});
  const body=await r.text();
  return {status:r.status,body,headers:r.headers,json:()=>JSON.parse(body)};
 };
 const logFile=path.join(dataRoot,'mcp-performance.jsonl');
 const rpc=async method=>{
  const args={name:'dev_get_guide',arguments:{unrecognizedSecret:'NEVER-LOG-THIS-ARG-ALPHA'}};
  return call('/mcp','POST',{jsonrpc:'2.0',id:'PRIVATE-RPC-ID',method,params:method==='tools/call'?args:{}},
    {Authorization:'Bearer '+config.bearerToken});
 };
 assert.equal((await rpc('ping')).status,200);
 await app.admin.performance.flush();
 await assert.rejects(stat(logFile),{code:'ENOENT'});
 assert.equal((await call('/admin/api/performance')).status,401);
 const login=await call('/admin/api/login','POST',{password:config.password});
 assert.equal(login.status,200);
 const Cookie=login.headers.get('set-cookie').split(';')[0];
 const session=(await call('/admin/api/session','GET',undefined,{Cookie})).json();
 const headers={Cookie,'X-CSRF-Token':session.csrf};
 assert.equal((await call('/admin/api/performance','PUT',{enabled:true,maxFileMB:1,slowMs:1},{Cookie})).status,403);
 assert.equal((await call('/admin/api/performance','PUT',{enabled:true,maxFileMB:1,slowMs:1},headers)).status,200);
 assert.equal(app.admin.traces.debugEnabled,true);
 const one=await rpc('tools/call');
 assert.equal(one.status,200);
 const trace=one.json().result._meta['dev/trace_id'];
 assert.match(trace,/^[a-f0-9-]{36}$/);
 assert.equal((await rpc('ping')).status,200);
 // Tool error over HTTP 200 must retain logical failure.
 assert.equal((await call('/mcp','POST',{jsonrpc:'2.0',id:21,method:'tools/call',
   params:{name:'bad_tool',arguments:{secret:'LEAK-NEVER-BETA'}}},
   {Authorization:'Bearer '+config.bearerToken})).status,200);
 await app.admin.performance.flush();
 const summary=(await call('/admin/api/performance?limit=40','GET',undefined,{Cookie})).json();
 assert.ok(summary.sample_count>=3,JSON.stringify(summary));
 assert.ok(summary.entries.some(x=>x.tool==='dev_get_guide' && x.trace_id===trace));
 assert.ok(summary.entries.some(x=>x.tool==='unknown_tool'));
 const debug=(await call('/admin/api/performance/trace?trace_id='+trace,'GET',undefined,{Cookie})).json();
 assert.ok(debug.calls[0].debug.points.some(x=>x.stage==='policy.end'));
 const download=await call('/admin/api/performance/download','GET',undefined,{Cookie});
 assert.equal(download.status,200);
 assert.match(download.headers.get('content-type'),/application\/x-ndjson/);
 for(const secret of ['NEVER-LOG-THIS-ARG-ALPHA','LEAK-NEVER-BETA','SENSITIVE-MCP-BEARER-NOT-IN-LOG','PRIVATE-RPC-ID','ADMIN-PASSWORD-NOT-IN-LOG'])
   assert.ok(!download.body.includes(secret),secret);
 assert.ok(download.body.includes('"request_bytes"'));
 assert.ok(download.body.includes('"policy.end"'));
 assert.equal((await call('/admin/api/performance/clear','POST',{password:'wrong'},headers)).status,403);
 assert.equal((await call('/admin/api/performance/clear','POST',{password:config.password},headers)).status,200);
 const emptied=(await call('/admin/api/performance?limit=5','GET',undefined,{Cookie})).json();
 assert.equal(emptied.sample_count,0);
 assert.equal((await call('/admin/api/performance','PUT',{enabled:false,maxFileMB:1,slowMs:1},headers)).status,200);
 assert.equal(app.admin.traces.debugEnabled,false);
 const after=await rpc('ping');
 assert.equal(after.status,200);
 await app.admin.performance.flush();
 assert.equal((await call('/admin/api/performance?limit=5','GET',undefined,{Cookie})).json().sample_count,0);
 assert.equal((await readFile(path.join(dataRoot,'admin-settings.json'),'utf8')).includes('"enabled": false'),true);
});

test('exact trace lookup avoids parsing unrelated historical files',async t=>{
 const root=await temp(t);
 const {Traces}=await import('../src/trace.mjs');
 const store=new Traces(root);await store.init();
 const trace_id='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
 const folder=path.join(root,'traces');
 await writeFile(path.join(folder,'1700000000000-'+trace_id+'.json'),
   JSON.stringify({trace_id,tool:'job_read',status:'succeeded'}));
 for(let i=0;i<100;i++){
   const noisy='170000000000'+String(i).padStart(3,'0')+'-'+
      ('b'.repeat(35)+(i%10)).slice(0,36)+'.json';
   await writeFile(path.join(folder,noisy),'{ unrelated malformed record');
 }
 const found=await store.read({trace_id,limit:1});
 assert.equal(found.calls.length,1);
 assert.equal(found.calls[0].trace_id,trace_id);
 assert.equal(found.retained_calls,1);
 const missing=await store.read({trace_id:'00000000-0000-4000-8000-000000000000',limit:1});
 assert.deepEqual(missing.calls,[]);
});
