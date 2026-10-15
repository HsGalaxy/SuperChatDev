import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../src/server.mjs';
import {PerformanceLog,validatePerformance} from '../src/performance.mjs';

async function fixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'scd-payload-'));
 const workspace=path.join(root,'workspace'),dataRoot=path.join(root,'state');
 await Promise.all([mkdir(workspace),mkdir(dataRoot)]);
 t.after(()=>rm(root,{force:true,recursive:true}));
 const bearer='SYNTHETIC-MCP-BEARER-NOT-IN-CAPTURE';
 const adminPassword='SYNTHETIC-ADMIN-PASSWORD-NOT-IN-CAPTURE';
 const app=await createApp({workspace,dataRoot,bearerToken:bearer,password:adminPassword});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>app.server.close(resolve)));
 const base='http://127.0.0.1:'+app.server.address().port;
 const request=async(route,method='GET',body,headers={})=>{
   const response=await fetch(base+route,{method,
     headers:{...headers,...(body===undefined?{}:{'content-type':'application/json'})},
     ...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
   const text=await response.text();
   return {status:response.status,headers:response.headers,text,json:()=>JSON.parse(text)};
 };
 const login=await request('/admin/api/login','POST',{password:adminPassword});
 assert.equal(login.status,200);
 const Cookie=login.headers.get('set-cookie').split(';')[0];
 const session=(await request('/admin/api/session','GET',undefined,{Cookie})).json();
 const auth={Cookie,'X-CSRF-Token':session.csrf};
 const putSettings=(settings,password)=>request('/admin/api/performance','PUT',{...settings,...(password?{password}:{})},auth);
 const rpc=async(method,params)=>{
   const content={jsonrpc:'2.0',id:'SYNTHETIC-RPC-ID',method,...(params?{params}:{})};
   const sent=JSON.stringify(content);
   const response=await request('/mcp','POST',sent,{Authorization:'Bearer '+bearer});
   return {response,sent};
 };
 return {root,workspace,dataRoot,bearer,adminPassword,app,request,auth,Cookie,putSettings,rpc};
}
test('raw capture must be a second explicit opt-in; old settings migrate safely',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'scd-payload-settings-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new PerformanceLog(root);
 assert.equal(store.enabled(),false);
 assert.equal(store.contentEnabled(),false);
 assert.deepEqual(store.config.captureContent,false);
 assert.throws(()=>validatePerformance({enabled:false,captureContent:true}),/Invalid/);
 for(const input of [{enabled:true,captureContent:'yes'},{enabled:true,maxContentFileMB:0},
   {enabled:true,maxBodyKB:4097},{enabled:true,maxBodyKB:15},
   {enabled:true,captureContent:true,arbitraryCredential:'bad'}])
   assert.throws(()=>validatePerformance(input),/Invalid/);
 store.configure({enabled:true,maxFileMB:1,slowMs:20});
 assert.equal(store.contentEnabled(),false);
 assert.equal(store.config.maxBodyKB,512);
});
test('MCP original request and response are captured exactly; Admin session, CSRF and password protect viewing/export',async t=>{
 const f=await fixture(t);
 const {app,request,auth,putSettings,rpc,adminPassword,dataRoot,bearer,Cookie}=f;
 const expected={enabled:true,captureContent:true,maxFileMB:1,maxContentFileMB:1,maxBodyKB:16,slowMs:1};
 const baseline=await rpc('ping');
 assert.equal(baseline.response.status,200);
 await app.admin.performance.flush();
 await assert.rejects(stat(path.join(dataRoot,'mcp-content.jsonl')),{code:'ENOENT'});
 await assert.rejects(stat(path.join(dataRoot,'mcp-performance.jsonl')),{code:'ENOENT'});
 // A generic Admin settings PUT cannot silently turn on recording secrets.
 const generic=(await request('/admin/api/settings','GET',undefined,{Cookie})).json();
 const bypass={...generic.settings,performance:expected};
 const refused=await request('/admin/api/settings','PUT',bypass,auth);
 assert.notEqual(refused.status,200);
 assert.equal(app.admin.performance.contentEnabled(),false);
 assert.equal((await putSettings(expected)).status,403);
 assert.equal((await putSettings(expected,'wrong')).status,403);
 assert.equal((await putSettings(expected,adminPassword)).status,200);
 assert.equal(app.admin.performance.contentEnabled(),true);
 const sentinel='PAYLOAD-CONTAINS-TEST-API-KEY-SENTINEL';
 const {sent,response}=await rpc('tools/call',{name:'dev_get_guide',
   arguments:{include_diagnostics:false,synthetic_test_secret:sentinel}});
 assert.equal(response.status,200);
 assert.equal((await rpc('ping')).response.status,200);
 // Capture an actual tool response containing workspace file bytes, not
 // merely arguments. This is why full-capture mode must be treated as secret.
 const responseSecret='SYNTHETIC-FILE-OUTPUT-SECRET-CAN-APPEAR';
 await (await import('node:fs/promises')).writeFile(path.join(f.workspace,'sample.txt'),responseSecret+'\n');
 const fileRead=await rpc('tools/call',{name:'fs_read',arguments:{files:[{path:'sample.txt'}]}});
 assert.equal(fileRead.response.status,200);
 assert.ok(fileRead.response.text.includes(responseSecret));
 await app.admin.performance.flush();
 const m=(await request('/admin/api/performance?limit=20','GET',undefined,{Cookie})).json();
 const selected=m.entries.find(x=>x.tool==='dev_get_guide'&&x.capture_id);
 assert.ok(selected,JSON.stringify(m.entries));
 assert.match(selected.capture_id,/^[0-9a-f-]{36}$/);
 assert.ok(!JSON.stringify(m).includes(sentinel));
 assert.ok(!JSON.stringify(m).includes(bearer));
 const filename=path.join(dataRoot,'mcp-content.jsonl');
 assert.equal((await stat(filename)).mode&0o777,0o600);
 const content=await readFile(filename,'utf8');
 assert.ok(content.includes(sentinel));
 assert.ok(!content.includes(adminPassword));
 assert.ok(!content.includes(bearer));
 // A GET may not return sensitive content, nor may unauthenticated or
 // CSRF-less POSTs. Even a valid Admin cookie requires password.
 assert.notEqual((await request('/admin/api/performance/content/read?capture_id='+selected.capture_id,'GET',undefined,{Cookie})).status,200);
 assert.equal((await request('/admin/api/performance/content/read','POST',{capture_id:selected.capture_id,password:adminPassword})).status,401);
 assert.equal((await request('/admin/api/performance/content/read','POST',{capture_id:selected.capture_id,password:adminPassword},{Cookie})).status,403);
 assert.equal((await request('/admin/api/performance/content/read','POST',{capture_id:selected.capture_id,password:'wrong'},auth)).status,403);
 const revealed=await request('/admin/api/performance/content/read','POST',
   {capture_id:selected.capture_id,password:adminPassword},auth);
 assert.equal(revealed.status,200);
 const capture=revealed.json();
 assert.equal(capture.capture_id,selected.capture_id);
 assert.equal(capture.trace_id,selected.trace_id);
 assert.deepEqual(capture.request,{present:true,bytes:Buffer.byteLength(sent),truncated:false,text:sent});
 assert.equal(capture.response.truncated,false);
 assert.equal(capture.response.text,response.text);
 assert.equal(JSON.parse(capture.response.text).jsonrpc,'2.0');
 const downloadBad=await request('/admin/api/performance/content/download','POST',{password:'wrong'},auth);
 assert.equal(downloadBad.status,403);
 const download=await request('/admin/api/performance/content/download','POST',{password:adminPassword},auth);
 assert.equal(download.status,200);
 assert.match(download.headers.get('content-disposition'),/sensitive/);
 assert.ok(download.text.includes(sentinel));
 assert.ok(download.text.includes(responseSecret));
 assert.ok(!download.text.includes(bearer));
 // Standard metrics export stays content-free.
 const meta=await request('/admin/api/performance/download','GET',undefined,{Cookie});
 assert.equal(meta.status,200);
 assert.ok(!meta.text.includes(sentinel));
 const missing=await request('/admin/api/performance/content/read','POST',
   {capture_id:'00000000-0000-4000-8000-000000000000',password:adminPassword},auth);
 assert.equal(missing.status,404);
});
test('capture is size/rotation bounded, supports errors, and stops without overhead when disabled',async t=>{
 const f=await fixture(t);
 const {app,request,auth,putSettings,rpc,adminPassword,dataRoot,Cookie}=f;
 const on={enabled:true,captureContent:true,maxFileMB:1,maxContentFileMB:1,maxBodyKB:16,slowMs:0};
 assert.equal((await putSettings(on,adminPassword)).status,200);
 const oversize='HEAD_MARKER_'+('X'.repeat(22000))+'_TAIL_MARKER';
 const {response}=await rpc('ping',{oversize});
 assert.equal(response.status,200);
 await app.admin.performance.flush();
 let summary=(await request('/admin/api/performance?limit=20','GET',undefined,{Cookie})).json();
 const entry=summary.entries.find(x=>x.method==='ping'&&x.capture_id);
 assert.ok(entry);
 const selected=(await request('/admin/api/performance/content/read','POST',
   {capture_id:entry.capture_id,password:adminPassword},auth)).json();
 assert.equal(selected.request.truncated,true);
 assert.ok(selected.request.text.includes('HEAD_MARKER_'));
 assert.ok(selected.request.text.includes('_TAIL_MARKER'));
 assert.ok(selected.request.omitted_bytes>0);
 assert.ok(!selected.response.truncated);
 // Force a rotation in the content journal with bounded, synthetic requests.
 for(let i=0;i<74;i++){
   const result=await rpc('ping',{message:'M'.repeat(14950),iteration:i});
   assert.equal(result.response.status,200);
 }
 await app.admin.performance.flush();
 const file=path.join(dataRoot,'mcp-content.jsonl');
 const previous=file+'.1';
 assert.ok((await stat(file)).size<=1024*1024);
 assert.ok((await stat(previous)).size<=1024*1024);
 const before=await stat(file);
 const old=await stat(previous);
 // Metadata-only mode must stop retaining bodies immediately.
 const metricsOnly={...on,captureContent:false};
 assert.equal((await putSettings(metricsOnly)).status,200);
 const offCapture=await rpc('ping',{should_not_appear:'NO-LOG-AFTER-CAPTURE-OFF'});
 assert.equal(offCapture.response.status,200);
 await app.admin.performance.flush();
 assert.equal((await stat(file)).size,before.size);
 assert.equal((await stat(previous)).size,old.size);
 summary=(await request('/admin/api/performance?limit=1','GET',undefined,{Cookie})).json();
 assert.equal(summary.entries[0].capture_id,undefined);
 // Full disable: no extra metrics or content. Old logs persist until cleared.
 assert.equal((await putSettings({...metricsOnly,enabled:false})).status,200);
 const metricsBefore=await stat(path.join(dataRoot,'mcp-performance.jsonl'));
 const last=await rpc('ping');
 assert.equal(last.response.status,200);
 await app.admin.performance.flush();
 assert.equal((await stat(path.join(dataRoot,'mcp-performance.jsonl'))).size,metricsBefore.size);
 const failed=await request('/admin/api/performance/clear','POST',{password:'bad'},auth);
 assert.equal(failed.status,403);
 const cleared=await request('/admin/api/performance/clear','POST',{password:adminPassword},auth);
 assert.equal(cleared.status,200);
 await assert.rejects(stat(file),{code:'ENOENT'});
 await assert.rejects(stat(previous),{code:'ENOENT'});
 await assert.rejects(stat(path.join(dataRoot,'mcp-performance.jsonl')),{code:'ENOENT'});
});


test('worst-case escaped payloads cannot overflow a sensitive journal file',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'scd-payload-escaped-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const log=new PerformanceLog(root);
 log.configure({enabled:true,captureContent:true,maxFileMB:1,maxContentFileMB:1,maxBodyKB:4096,slowMs:0});
 const id='11111111-2222-4333-8444-555555555555';
 const raw='\n'.repeat(700000)+'TRAILER-END';
 log.capture({capture_id:id,method:'tools/call',tool:'fs_read',status:200,
   request_body:raw,response_body:raw});
 await log.flush();
 const item=await log.readContent(id);
 assert.equal(item.capture_id,id);
 assert.equal(item.request.bytes,Buffer.byteLength(raw));
 assert.equal(item.request.truncated,true);
 assert.equal(item.request.skipped,'escaped_content_exceeds_journal_limit');
 assert.ok((await stat(path.join(root,'mcp-content.jsonl'))).size<=1024*1024);
});

test('capture queue retains no more than 32 MiB of sensitive previews under burst load',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'scd-payload-pressure-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const log=new PerformanceLog(root);
 log.configure({enabled:true,captureContent:true,maxFileMB:1,maxContentFileMB:1,
   maxBodyKB:4096,slowMs:0});
 const body='P'.repeat(4096*1024);
 for(let i=0;i<12;i++){
   const id='99999999-9999-4999-8999-'+String(i).padStart(12,'0');
   log.capture({capture_id:id,method:'ping',status:200,request_body:body,response_body:body});
 }
 assert.ok(log.contentDropped>=1);
 assert.ok(log.queuedContentBytes<=32*1024*1024);
 await log.flush();
 assert.equal(log.queuedContentBytes,0);
 const report=await log.summary(20);
 assert.ok(report.content_dropped>=1);
 assert.ok((await stat(path.join(root,'mcp-content.jsonl'))).size<=1024*1024);
});
