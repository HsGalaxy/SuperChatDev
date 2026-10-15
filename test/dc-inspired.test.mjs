import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { CodeTools } from '../src/code-tools.mjs';
import { editSuggestions } from '../src/edit-diagnostics.mjs';
import { Jobs } from '../src/jobs.mjs';
import { Workspace, validatePlan } from '../src/workspace.mjs';
import { createApp } from '../src/server.mjs';

async function fixture(t) {
  const root=await mkdtemp(path.join(os.tmpdir(),'superchatdev-dc-'));
  const workspace=path.join(root,'workspace');
  const dataRoot=path.join(root,'state');
  await mkdir(workspace);await mkdir(dataRoot);
  t.after(()=>rm(root,{recursive:true,force:true}));
  return {root,workspace,dataRoot};
}
const sha = text=>createHash('sha256').update(text).digest('hex');

test('regex search is opt-in, paginated, scoped, and preserves literal defaults',async t=>{
  const c=await fixture(t);
  await mkdir(path.join(c.workspace,'src'));
  await writeFile(path.join(c.workspace,'src/main.js'),'const flow=42;\nconst flow=123;\nflow=regex\n');
  await writeFile(path.join(c.workspace,'.env'),'flow=800; PRIVATE');
  await symlink(c.dataRoot,path.join(c.workspace,'src/escape'));
  const tools=new CodeTools(c);
  const tree=await tools.list({path:'src',depth:1,details:true});
  const entry=tree.entries.find(item=>item.path==='src/main.js');
  assert.equal(entry.size,Buffer.byteLength('const flow=42;\nconst flow=123;\nflow=regex\n'));
  assert.match(entry.modified_at,/Z$/);
  assert.match(entry.permissions,/^0[0-7]{3}$/);
  const linkEntry=tree.entries.find(item=>item.type==='symlink');
  assert.match(linkEntry.metadata_error,/symlink/i);
  const literal=await tools.search({query:'flow=[0-9]+'});
  assert.equal(literal.matches.length,0);
  const first=await tools.search({query:'flow=[0-9]+',regex:true,limit:1});
  assert.equal(first.matches.length,1);assert.equal(first.matches[0].line,1);
  assert.ok(first.next_cursor);
  assert.equal(first.matches[0].sha256,sha('const flow=42;\nconst flow=123;\nflow=regex\n'));
  const second=await tools.search({query:'flow=[0-9]+',regex:true,limit:1,cursor:first.next_cursor});
  assert.equal(second.matches[0].line,2);
  assert.ok(second.matches[0].context.some(line=>line.text==='const flow=42;'));
  await assert.rejects(tools.search({query:'flow=[0-9]+',regex:false,cursor:first.next_cursor}),/cursor/);
  await assert.rejects(tools.search({query:'[broken',regex:true}),/Invalid regex/);
  const insensitive=await tools.search({query:'FLOW=[0-9]+',regex:true,case_sensitive:false});
  assert.equal(insensitive.matches.length,2);
  assert.ok(insensitive.matches.every(hit=>hit.path==='src/main.js'));
});
test('pathological user regex is aborted without wedging the event loop',async t=>{
  const c=await fixture(t);
  await writeFile(path.join(c.workspace,'input.txt'),'a'.repeat(12000)+'X\n');
  const tools=new CodeTools(c),start=performance.now();
  const answer=await tools.search({query:'(a+)+$',regex:true,limit:2});
  assert.ok(performance.now()-start<5000,'Regex should have a bounded execution time');
  assert.equal(answer.regex_timed_out,true);
  assert.ok(answer.skipped.some(item=>item.reason.includes('timed out')));
});
test('tail of a large UTF-8 file is bounded and does not invent a full hash',async t=>{
  const c=await fixture(t);
  await writeFile(path.join(c.workspace,'huge.log'),'noise\n'.repeat(780000)+'final 中文\nlast error ✅\n');
  const tools=new CodeTools(c);
  const normal=await tools.read({files:[{path:'huge.log'}]});
  assert.match(normal.files[0].error,/exceeds native text-read/);
  const tail=await tools.read({files:[{path:'huge.log',tail_lines:2}]});
  assert.equal(tail.files[0].sha256,null);
  assert.equal(tail.files[0].read_only_tail,true);
  assert.equal(tail.files[0].line_numbers_relative,true);
  assert.match(tail.files[0].numbered_text,/final 中文/);
  assert.match(tail.files[0].numbered_text,/last error ✅/);
  const small=await tools.read({files:[{path:'huge.log',tail_lines:2,expected_sha256:'f'.repeat(64)}]});
  assert.match(small.files[0].error,/SHA-256/);
  await writeFile(path.join(c.workspace,'short.txt'),'one\ntwo\nthree\n');
  const short=await tools.read({files:[{path:'short.txt',tail_lines:2}]});
  assert.equal(short.files[0].sha256,sha('one\ntwo\nthree\n'));
  assert.equal(short.files[0].start_line,2);
  assert.match(short.files[0].numbered_text,/2: two/);
  assert.match(short.files[0].numbered_text,/3: three/);
  await assert.rejects(tools.read({files:[{path:'short.txt',tail_lines:2,start_line:1}]}),/either/);
});
test('editing suggestions are short, ranked, and never rewrite code',()=>{
  const source='first line\nconst retries=4;\nnext line\n';
  const hints=editSuggestions(source,'const retries = 4;');
  assert.ok(hints.length>=1);
  assert.equal(hints[0].line,2);
  assert.match(hints[0].actual,/retries=4/);
  assert.match(hints[0].difference,/\{-/);
  assert.equal(source,'first line\nconst retries=4;\nnext line\n');
});
test('copy and move use source SHA guards, reject clobber and symlink escapes',async t=>{
  const c=await fixture(t);
  const jobs=new Jobs(c);await jobs.init();
  const batches=new Workspace(c,jobs);await batches.init();
  await writeFile(path.join(c.workspace,'source.txt'),'secretless content\n');
  await writeFile(path.join(c.workspace,'taken.txt'),'keep\n');
  const expected_sha256=sha('secretless content\n');
  assert.throws(()=>validatePlan({steps:[{type:'copy',source:'source.txt',destination:'new.txt'}]}),/expected_sha256/);
  assert.throws(()=>validatePlan({steps:[{type:'move',source:'source.txt',destination:'../escape',expected_sha256}]}),/traversal/);
  assert.throws(()=>validatePlan({steps:[
    {id:'copy',type:'copy',source:'source.txt',destination:'new.txt',expected_sha256,depends_on:[]},
    {id:'write',type:'write',path:'source.txt',content:'changed',depends_on:[]}
  ]}),/Parallel writes conflict/);
  const wrongHash=await batches.execute({wait_ms:10000,steps:[
    {type:'copy',source:'source.txt',destination:'wrong.txt',expected_sha256:'0'.repeat(64)}
  ]});
  assert.equal(wrongHash.status,'failed');
  await assert.rejects(readFile(path.join(c.workspace,'wrong.txt')),{code:'ENOENT'});
  const copied=await batches.execute({wait_ms:10000,steps:[
    {type:'copy',source:'source.txt',destination:'sub/copied.txt',expected_sha256}
  ]});
  assert.equal(copied.status,'succeeded',JSON.stringify(copied));
  assert.equal(await readFile(path.join(c.workspace,'source.txt'),'utf8'),'secretless content\n');
  assert.equal(await readFile(path.join(c.workspace,'sub/copied.txt'),'utf8'),'secretless content\n');
  const refuse=await batches.execute({wait_ms:10000,steps:[
    {type:'copy',source:'source.txt',destination:'taken.txt',expected_sha256}
  ]});
  assert.equal(refuse.status,'failed');
  assert.equal(await readFile(path.join(c.workspace,'taken.txt'),'utf8'),'keep\n');
  const move=await batches.execute({wait_ms:10000,steps:[
    {type:'move',source:'sub/copied.txt',destination:'sub/moved.txt',expected_sha256}
  ]});
  assert.equal(move.status,'succeeded',JSON.stringify(move));
  assert.equal(await readFile(path.join(c.workspace,'sub/moved.txt'),'utf8'),'secretless content\n');
  await assert.rejects(readFile(path.join(c.workspace,'sub/copied.txt')),{code:'ENOENT'});
  await symlink(c.dataRoot,path.join(c.workspace,'out-link'));
  const blocked=await batches.execute({wait_ms:10000,steps:[
    {type:'copy',source:'source.txt',destination:'out-link/nope',expected_sha256}
  ]});
  assert.equal(blocked.status,'failed');
});
test('failed exact replace surfaces read-only near-match suggestions in durable batch',async t=>{
  const c=await fixture(t);
  const jobs=new Jobs(c);await jobs.init();
  const batches=new Workspace(c,jobs);await batches.init();
  const content='first line\nconst retries=4;\nnext line\n';
  await writeFile(path.join(c.workspace,'edit.js'),content);
  const failed=await batches.execute({wait_ms:10000,steps:[
    {type:'replace',path:'edit.js',old_text:'const retries = 4;',new_text:'changed',expected_sha256:sha(content)}
  ]});
  assert.equal(failed.status,'failed',JSON.stringify(failed));
  assert.equal(failed.steps[0].result.diagnostic.type,'no_exact_match');
  assert.ok(failed.steps[0].result.diagnostic.suggestions.some(x=>x.line===2));
  assert.equal(await readFile(path.join(c.workspace,'edit.js'),'utf8'),content);
  const passed=await batches.execute({wait_ms:10000,steps:[
    {type:'replace',path:'edit.js',old_text:'const retries=4;',new_text:'const retries=5;',expected_sha256:sha(content)}
  ]});
  assert.equal(passed.status,'succeeded',JSON.stringify(passed));
  assert.match(await readFile(path.join(c.workspace,'edit.js'),'utf8'),/retries=5/);
});

test('patch-context diagnostics remain advisory and preserve the source file',async t=>{
  const c=await fixture(t);
  const jobs=new Jobs(c);await jobs.init();
  const batches=new Workspace(c,jobs);await batches.init();
  const original='const magic=41;\n';
  await writeFile(path.join(c.workspace,'file.js'),original);
  const patch='--- a/file.js\n+++ b/file.js\n@@ -1 +1 @@\n-const magic=42;\n+const magic=43;\n';
  const answer=await batches.execute({wait_ms:10000,steps:[{
    type:'patch',patch,expected_sha256:{'file.js':sha(original)}
  }]});
  assert.equal(answer.status,'failed',JSON.stringify(answer));
  assert.equal(answer.steps[0].result.diagnostic?.type,'patch_context_mismatch');
  assert.ok(answer.steps[0].result.diagnostic.suggestions.length>0);
  assert.equal(await readFile(path.join(c.workspace,'file.js'),'utf8'),original);
});

test('real MCP HTTP core workflow exposes regex, tail, metadata, and guarded copy',async t=>{
  const c=await fixture(t);
  const app=await createApp({...c,bearerToken:'test-token',httpOrigins:[],allowedOrigins:[]});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{
    app.server.closeAllConnections();
    await new Promise(resolve=>app.server.close(resolve));
  });
  const url='http://127.0.0.1:'+app.server.address().port+'/mcp';
  async function rpc(method,params={}){
    const response=await fetch(url,{method:'POST',headers:{
      authorization:'Bearer test-token','content-type':'application/json'
    },body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
    assert.equal(response.status,200);
    const value=await response.json();
    assert.equal(value.error,undefined,JSON.stringify(value));
    return value.result;
  }
  const call=(name,args)=>rpc('tools/call',{name,arguments:args});
  await writeFile(path.join(c.workspace,'hello.js'),'const answer=42;\nlast error\n');
  const tools=(await rpc('tools/list')).tools;
  assert.equal(tools.length,16);
  assert.ok(tools.find(tool=>tool.name==='fs_search').inputSchema.properties.regex);
  assert.ok(tools.find(tool=>tool.name==='fs_read').inputSchema.properties.files.items.properties.tail_lines);
  const match=(await call('fs_search',{query:'answer=[0-9]+',regex:true})).structuredContent;
  assert.equal(match.matches.length,1);
  const detail=(await call('fs_list',{details:true})).structuredContent;
  assert.ok(detail.entries.some(entry=>entry.name==='hello.js'&&entry.size>0));
  const tail=(await call('fs_read',{files:[{path:'hello.js',tail_lines:1}]})).structuredContent;
  assert.match(tail.files[0].numbered_text,/last error/);
  const execution=await call('workspace_execute',{wait_ms:10000,steps:[{
    type:'copy',source:'hello.js',destination:'copied.js',
    expected_sha256:sha('const answer=42;\nlast error\n')
  }]});
  assert.equal(execution.isError,undefined,JSON.stringify(execution));
  assert.equal(execution.structuredContent.status,'succeeded');
  assert.equal(await readFile(path.join(c.workspace,'copied.js'),'utf8'),'const answer=42;\nlast error\n');
});
