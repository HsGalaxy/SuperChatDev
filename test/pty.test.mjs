import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,stat} from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {Jobs} from '../src/jobs.mjs';
import {createApp} from '../src/server.mjs';

const available=spawnSync('/usr/bin/script',['--version'],{encoding:'utf8'}).status===0;

async function fixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'scd-pty-'));
 const workspace=path.join(root,'work'),dataRoot=path.join(root,'data');
 await mkdir(workspace);await mkdir(dataRoot);
 t.after(()=>rm(root,{recursive:true,force:true}));
 const jobs=new Jobs({workspace,dataRoot});await jobs.init();
 return {jobs,workspace,dataRoot};
}

async function sendWhenReady(jobs,id,text){
 for(let i=0;i<35;i++){
  try { return await jobs.input({job_id:id,chars:text,wait_ms:2000}); }
  catch(e){if(!/ENOENT|ECONNREFUSED|NOT_RUNNING|queued/i.test(e.message))throw e;}
  await delay(70);
 }
 throw new Error('PTY socket was never ready');
}

test('PTY interactive command exposes a terminal and accepts later input', {skip:!available}, async t=>{
 const {jobs}=await fixture(t);
 const command='test -t 0 && echo TTY_READY; IFS= read -r value; echo "ANSWER:$value"';
 const session=await jobs.start({argv:['bash','-c',command],tty:true,wait_ms:0});
 assert.equal(session.tty,true);
 const answer=await sendWhenReady(jobs,session.id,'hello\n');
 const text=(answer.output||'')+' '+(answer.output_preview||'');
 assert.match(text,/TTY_READY/);
 assert.match(text,/ANSWER:hello/);
 assert.equal(answer.input_accepted,true);
 assert.equal(answer.input_bytes,6);
 for(let i=0;i<35;i++){
  const state=await jobs.status(session.id);
  if(state.status==='succeeded'){assert.equal(state.exit_code,0);return;}
  await delay(60);
 }
 assert.fail('TTY job never completed');
});

test('PTY argument quoting preserves literal shell-sensitive argv', {skip:!available}, async t=>{
 const {jobs,workspace}=await fixture(t);
 const token="unsafe'$(touch evil_file)";
 const result=await jobs.start({argv:['printf','ARG:%s\n',token],tty:true,wait_ms:4000});
 assert.equal(result.status,'succeeded',JSON.stringify(result));
 assert.match(result.output,/ARG:unsafe'\$\(touch evil_file\)/);
 await assert.rejects(stat(path.join(workspace,'evil_file')),{code:'ENOENT'});
});

test('default tool catalog stays at 16 and PTY input is opt-in',async t=>{
 const {workspace,dataRoot}=await fixture(t);
 const app=await createApp({workspace,dataRoot,bearerToken:'test-only'});
 t.after(()=>app.server.close());
 assert.equal(app.catalog().visible_tools.length,16);
 assert.ok(!app.catalog().visible_tools.includes('job_input'));
 assert.equal(app.admin.allowed('job_input'),false);
 app.admin.settings.toolProfile='interactive';
 assert.ok(app.catalog().visible_tools.includes('job_input'));
 assert.equal(app.admin.allowed('job_input'),true);
 app.admin.settings.permissions.commandExecution=false;
 assert.equal(app.admin.allowed('job_input'),false);
});

test('cancelled PTY job terminates its foreground program and removes socket', {skip:!available}, async t=>{
 const {jobs}=await fixture(t);
 const command='echo "PTY_CHILD_PID=$$"; exec sleep 30';
 const session=await jobs.start({argv:['bash','-c',command],tty:true,wait_ms:0});
 let output='';
 for(let i=0;i<35;i++){
  const current=await jobs.read({job_id:session.id,offset:0,max_bytes:4096,wait_ms:250});
  output=current.output||'';
  if(output.includes('PTY_CHILD_PID='))break;
  await delay(50);
 }
 const match=output.match(/PTY_CHILD_PID=(\d+)/);
 assert.ok(match,JSON.stringify({output}));
 const childPid=Number(match[1]);
 assert.ok(Number.isSafeInteger(childPid));
 const stopped=await jobs.cancel({job_id:session.id});
 assert.ok(['cancelled','running','queued'].includes(stopped.status));
 for(let i=0;i<80;i++){
  const status=await jobs.status(session.id);
  let exists;
  try {await stat('/proc/'+childPid); exists=true;}catch(error){if(error.code!=='ENOENT')throw error;exists=false;}
  if(status.status==='cancelled'&&!exists){
   await assert.rejects(stat(path.join(jobs.directory(session.id),'tty.sock')),{code:'ENOENT'});
   return;
  }
  await delay(40);
 }
 assert.fail('PTY child or input socket survived cancellation');
});

test('MCP Core refuses PTY; interactive profile routes PTY and input through jobs', {skip:!available},async t=>{
 const {workspace,dataRoot}=await fixture(t);
 const app=await createApp({workspace,dataRoot,bearerToken:'test-only'});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>app.server.close(resolve)));
 const url='http://127.0.0.1:'+app.server.address().port+'/mcp';
 const call=async(name,args)=>{
  const res=await fetch(url,{method:'POST',headers:{authorization:'Bearer test-only','content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
  return (await res.json()).result;
 };
 let rejected=await call('job_start',{argv:['bash','-c','echo hello'],tty:true});
 assert.equal(rejected.isError,true);
 assert.match(rejected.structuredContent.error.message,/interactive or legacy/);
 app.admin.settings.toolProfile='interactive';
 const launched=await call('job_start',{argv:['bash','-c','test -t 0 && echo READY; read x; echo REPLY:$x'],tty:true,wait_ms:0});
 assert.notEqual(launched.isError,true,JSON.stringify(launched));
 const job_id=launched.structuredContent.id;
 let accepted;
 for(let i=0;i<35;i++){
  accepted=await call('job_input',{job_id,chars:'ok\n',offset:0,wait_ms:1000});
  if(!accepted.isError)break;
  if(!/ENOENT|ECONNREFUSED|NOT_RUNNING/.test(accepted.structuredContent?.error?.message||''))
    assert.fail(JSON.stringify(accepted));
  await delay(70);
 }
 assert.equal(accepted.isError,undefined,JSON.stringify(accepted));
 assert.equal(accepted.structuredContent.input_accepted,true);
 assert.match(accepted.structuredContent.output,/REPLY:ok/);
});

test('exact replace needs filesystemRead and filesystemWrite permissions',async t=>{
 const {workspace,dataRoot}=await fixture(t);
 const app=await createApp({workspace,dataRoot,bearerToken:'test-only'});
 t.after(()=>app.server.close());
 const step={type:'replace',path:'file',old_text:'old',new_text:'new',expected_sha256:'a'.repeat(64)};
 app.admin.settings.permissions.filesystemWrite=false;
 assert.equal(app.admin.allowed('workspace_execute',{steps:[step]}),false);
 app.admin.settings.permissions.filesystemWrite=true;
 app.admin.settings.permissions.filesystemRead=false;
 assert.equal(app.admin.allowed('workspace_execute',{steps:[step]}),false);
});

test('PTY retry with the same request_id cannot type twice or alter the input', {skip:!available}, async t=>{
 const {jobs}=await fixture(t);
 const session=await jobs.start({argv:['bash','-c','read -r a; echo ONE:$a; read -r b; echo TWO:$b'],tty:true,wait_ms:0});
 let first;
 for(let i=0;i<30;i++){
   try {
     first=await jobs.input({job_id:session.id,chars:'alpha\n',request_id:'type-first',offset:0,wait_ms:250});
     break;
   }catch(e){
     if(!/ENOENT|ECONNREFUSED|NOT_RUNNING/.test(e.message))throw e;
     await delay(60);
   }
 }
 assert.equal(first.input_reused,false);
 const dup=await jobs.input({job_id:session.id,chars:'alpha\n',request_id:'type-first',offset:0,wait_ms:150});
 assert.equal(dup.input_reused,true);
 await assert.rejects(jobs.input({job_id:session.id,chars:'altered\n',request_id:'type-first'}),/CONFLICT/);
 const second=await jobs.input({job_id:session.id,chars:'beta\n',request_id:'type-second',offset:0,wait_ms:1000});
 assert.match(second.output,/ONE:alpha/);
 assert.match(second.output,/TWO:beta/);
 assert.ok(!second.output.includes('TWO:alpha'));
});
