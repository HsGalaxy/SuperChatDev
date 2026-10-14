import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {spawnSync} from 'node:child_process';
import {Jobs,looksLikePrompt} from '../src/jobs.mjs';

const hasPTY=spawnSync('/usr/bin/script',['--version']).status===0;
async function testJobs(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'scd-interaction-'));
 const workspace=path.join(root,'workspace'),dataRoot=path.join(root,'data');
 await mkdir(workspace);await mkdir(dataRoot);
 t.after(()=>rm(root,{recursive:true,force:true}));
 const jobs=new Jobs({workspace,dataRoot});await jobs.init();
 return jobs;
}
test('shell and Python prompt recognition is heuristic, ANSI-safe and conservative',()=>{
 for(const prompt of ['>>> ','In [17]: ','user@host:~$ ','PS C:\\User> ','READY> ','# '])
   assert.equal(looksLikePrompt('output\n'+prompt),true,prompt);
 for(const text of ['','complete\n','The number is 12 > 10','a password:', 'not a prompt\nReady:',
   'random output\nrunning task ...','Exception: broken stack'])
   assert.equal(looksLikePrompt(text),false,text);
 assert.equal(looksLikePrompt('\x1b[32m>>> \x1b[0m'),true);
});
test('recent tail_lines can inspect the end of a completed log without affecting offset',async t=>{
 const jobs=await testJobs(t);
 const result=await jobs.start({argv:['bash','-c',"printf 'one\\ntwo\\nthree\\nfour\\n'"],wait_ms:2000});
 assert.equal(result.status,'succeeded');
 const page=await jobs.read({job_id:result.id,offset:0,max_bytes:5,tail_lines:2});
 assert.equal(page.output,'one\nt');
 assert.equal(page.output_tail,'three\nfour\n');
 assert.equal(page.next_offset,5);
 assert.equal(page.output_tail_complete,true);
 const continued=await jobs.read({job_id:result.id,offset:page.next_offset,max_bytes:64});
 assert.equal(page.output+continued.output,'one\ntwo\nthree\nfour\n');
 await assert.rejects(jobs.read({job_id:result.id,tail_lines:201}),/tail_lines/);
});
test('wait_for_prompt returns a complete interactive REPL response without extra stdin', {skip:!hasPTY}, async t=>{
 const jobs=await testJobs(t);
 const code="printf 'READY> '; while IFS= read -r line; do printf 'ANSWER:%s\\nREADY> ' \"$line\"; done";
 const running=await jobs.start({argv:['bash','-c',code],tty:true,wait_ms:0,timeout_seconds:20});
 let first;
 for(let attempt=0;attempt<50;attempt++){
   first=await jobs.read({job_id:running.id,offset:0,max_bytes:512,wait_ms:200});
   if(first.output?.includes('READY> '))break;
   await delay(25);
 }
 assert.match(first.output,/READY> /);
 assert.equal(first.interaction.state,'awaiting_input');
 let answer;
 try{
   answer=await jobs.input({job_id:running.id,chars:'alpha\n',offset:first.next_offset,
     wait_ms:3000,wait_for_prompt:true,request_id:'alpha-input'});
   assert.equal(answer.input_accepted,true);
   assert.equal(answer.waited_for_prompt,true);
   assert.match(answer.output,/ANSWER:alpha/);
   assert.ok(answer.output.endsWith('READY> '),JSON.stringify(answer));
   assert.equal(answer.interaction.state,'awaiting_input');
   assert.equal(answer.interaction.prompt_detected,true);
   // A deduplicated retry is acknowledged and cannot type a second line.
   const reused=await jobs.input({job_id:running.id,chars:'alpha\n',offset:answer.next_offset,
     wait_ms:150,wait_for_prompt:true,request_id:'alpha-input'});
   assert.equal(reused.input_reused,true);
   assert.ok(!reused.output.includes('ANSWER:alpha'));
 }finally{await jobs.cancel({job_id:running.id}).catch(()=>{});}
});
