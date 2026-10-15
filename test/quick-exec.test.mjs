import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import os from 'node:os';
import { QuickExec, quickExecTool } from '../src/quick-exec.mjs';
import { createApp } from '../src/server.mjs';

async function fixture(t) {
  const root=await mkdtemp(path.join(os.tmpdir(),'scd-quick-exec-'));
  const workspace=path.join(root,'workspace'),dataRoot=path.join(root,'state');
  await Promise.all([mkdir(workspace),mkdir(dataRoot)]);
  t.after(()=>rm(root,{recursive:true,force:true}));
  return { workspace,dataRoot,bearerToken:'local-test-bearer',httpOrigins:[] };
}

test('short command returns result in one call and separates failures from gateway errors',async t=>{
  const config=await fixture(t),exec=new QuickExec(config);
  const done=await exec.run({argv:['/bin/sh','-c','printf stdout; printf stderr >&2']});
  assert.equal(done.status,'succeeded');
  assert.equal(done.exit_code,0);
  assert.match(done.output,/stdout/);
  assert.match(done.output,/stderr/);
  assert.equal(done.ephemeral,true);
  assert.equal(done.output_truncated,false);
  const bad=await exec.run({command:'echo fail >&2; exit 17'});
  assert.equal(bad.status,'failed');
  assert.equal(bad.exit_code,17);
  assert.match(bad.output,/fail/);
  const missing=await exec.run({argv:['/no/such/executable']});
  assert.equal(missing.status,'failed');
  assert.equal(missing.exit_code,null);
  assert.ok(missing.error);
});

test('workspace path, explicit Bash vs argv, environment and input validation',async t=>{
  const config=await fixture(t),exec=new QuickExec(config);
  const a=await exec.run({command:"printf 'hello %s\\n' world"});
  assert.match(a.output,/hello world/);
  const arguments_=await exec.run({argv:[process.execPath,'-e','process.stdout.write(process.argv[1])','weird ; word']});
  assert.equal(arguments_.output,'weird ; word');
  const cwd=await exec.run({argv:['pwd']});
  assert.equal(cwd.output.trim(),config.workspace);
  await symlink(config.dataRoot,path.join(config.workspace,'private-link'));
  await assert.rejects(exec.run({argv:['pwd'],cwd:'private-link'}),/escapes (the )?workspace/i);
  await assert.rejects(exec.run({argv:['pwd'],cwd:'../../'}),/escapes (the )?workspace/i);
  await assert.rejects(exec.run({argv:['true'],command:'true'}),/exactly one/i);
  await assert.rejects(exec.run({argv:['true'],timeout_ms:31}),/timeout_ms/);
  await assert.rejects(exec.run({argv:['true'],max_output_bytes:999999}),/max_output_bytes/);
  const secrets=await exec.run({argv:[process.execPath,'-e',
    'console.log(Object.keys(process.env).filter(x=>x.startsWith("MCP_")).join(","))']});
  assert.equal(secrets.output.trim(),'');
});

test('bounded output preserves UTF-8 head and terminal error tail',async t=>{
  const exec=new QuickExec(await fixture(t));
  const result=await exec.run({argv:[process.execPath,'-e',
    "process.stdout.write('中文'.repeat(20000)+'\\nEND_FAILURE\\n')"],max_output_bytes:1024});
  assert.equal(result.status,'succeeded');
  assert.equal(result.output_truncated,true);
  assert.ok(result.omitted_bytes>1000);
  assert.match(result.output,/END_FAILURE/);
  assert.doesNotMatch(result.output,/\uFFFD/);
  assert.ok(Buffer.byteLength(result.output)<1300);
});

test('timed out process group is terminated before descendant can write',async t=>{
  const config=await fixture(t),exec=new QuickExec(config);
  const command="(sleep 1; echo not-allowed > marker) & wait";
  const started=performance.now();
  const result=await exec.run({command,timeout_ms:180});
  assert.equal(result.status,'timeout',JSON.stringify(result));
  assert.equal(result.timed_out,true);
  assert.ok(performance.now()-started<2200);
  await new Promise(resolve=>setTimeout(resolve,1100));
  await assert.rejects(readFile(path.join(config.workspace,'marker')),{code:'ENOENT'});
});

test('quick exec is capped at two simultaneous executions and releases slots',async t=>{
  const exec=new QuickExec(await fixture(t));
  const a=exec.run({argv:['sleep','0.4']});
  const b=exec.run({argv:['sleep','0.4']});
  await new Promise(resolve=>setTimeout(resolve,25));
  await assert.rejects(exec.run({argv:['true']}),/concurrency limit/);
  const results=await Promise.all([a,b]);
  assert.ok(results.every(r=>r.status==='succeeded'));
  assert.equal((await exec.run({argv:['true']})).status,'succeeded');
});

test('MCP tool discovery and permission enforcement match durable job_start',async t=>{
  const config=await fixture(t),app=await createApp(config);
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{app.server.closeAllConnections();await new Promise(ok=>app.server.close(ok));});
  const endpoint='http://127.0.0.1:'+app.server.address().port+'/mcp';
  const rpc=async(method,params={})=>{
    const response=await fetch(endpoint,{method:'POST',
      headers:{Authorization:'Bearer local-test-bearer','Content-Type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',method,params,id:1})});
    assert.equal(response.status,200);
    return (await response.json()).result;
  };
  const catalog=(await rpc('tools/list')).tools;
  assert.equal(catalog.length,17);
  assert.ok(catalog.some(tool=>tool.name===quickExecTool.name));
  const output=await rpc('tools/call',{name:'exec',arguments:{argv:['/usr/bin/printf','QUICK_OK']}});
  assert.equal(output.isError,undefined);
  assert.equal(output.structuredContent.output,'QUICK_OK');
  assert.equal(output.structuredContent.status,'succeeded');
  const before=app.admin.settings.permissions.commandExecution;
  app.admin.settings.permissions.commandExecution=false;
  const blocked=await rpc('tools/call',{name:'exec',arguments:{argv:['true']}});
  assert.equal(blocked.isError,true);
  assert.match(blocked.structuredContent.error.message,/disabled/);
  assert.ok(!(await rpc('tools/list')).tools.some(tool=>tool.name==='exec'));
  app.admin.settings.permissions.commandExecution=before;
  app.admin.settings.permissions.filesystemWrite=false;
  assert.equal((await rpc('tools/call',{name:'exec',arguments:{argv:['true']}})).isError,true);
  app.admin.settings.permissions.filesystemWrite=true;
  app.admin.settings.permissions.jobs=false;
  assert.equal((await rpc('tools/call',{name:'exec',arguments:{argv:['true']}})).isError,true);
  app.admin.settings.permissions.jobs=true;
  app.admin.settings.blockedTools.push('exec');
  assert.equal((await rpc('tools/call',{name:'exec',arguments:{argv:['true']}})).isError,true);
  app.admin.settings.blockedTools.pop();
});


test('pathological output is stopped after an 8 MiB total-output budget',async t=>{
  const exec=new QuickExec(await fixture(t));
  const started=performance.now();
  const result=await exec.run({argv:['/usr/bin/yes','test'],timeout_ms:8000,max_output_bytes:1024});
  assert.equal(result.status,'output_limit',JSON.stringify(result));
  assert.equal(result.output_limit_reached,true);
  assert.equal(result.output_truncated,true);
  assert.ok(result.output_bytes>8*1024*1024);
  assert.ok(performance.now()-started<6000);
  assert.ok(Buffer.byteLength(result.output)<1500);
});
