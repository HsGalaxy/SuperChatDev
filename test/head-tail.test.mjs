import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Jobs } from '../src/jobs.mjs';
import { TailBuffer } from '../src/head-tail.mjs';

function fixture(t) {
  return mkdtemp(path.join(os.tmpdir(), 'scd-tail-')).then(async root => {
    const workspace = path.join(root, 'work'), dataRoot = path.join(root, 'data');
    await mkdir(workspace);await mkdir(dataRoot);
    t.after(() => rm(root,{recursive:true,force:true}));
    const jobs = new Jobs({workspace,dataRoot,maxJobLogBytes:1024});
    await jobs.init();
    return {jobs};
  });
}

test('bounded ring retains terminal UTF-8 even across wraparound', () => {
 const b=new TailBuffer(10);
 b.push(Buffer.from('0123456'));b.push(Buffer.from('789ABC'));
 assert.equal(b.snapshot().toString(),'3456789ABC');
 b.push(Buffer.from('x'.repeat(100)));
 assert.equal(b.snapshot().toString(),'x'.repeat(10));
});

test('capped job logs keep original paged head but include final diagnostic tail',async t=>{
 const {jobs}=await fixture(t);
 const command='process.stdout.write("HEADER\\n"+"X".repeat(40000)+"\\nFINAL_ERROR: invalid token 💥\\n")';
 const state=await jobs.start({argv:[process.execPath,'-e',command],wait_ms:5000,max_bytes:512});
 assert.equal(state.status,'succeeded');
 assert.equal(state.log_truncated,true);
 assert.ok(state.dropped_log_bytes>38000);
 assert.equal(state.log_bytes,1024);
 assert.equal(state.next_offset,512);
 assert.match(state.output,/HEADER/);
 assert.ok(!state.output.includes('FINAL_ERROR'));
 assert.match(state.output_preview,/HEADER/);
 assert.match(state.output_preview,/FINAL_ERROR: invalid token 💥/);
 assert.match(state.output_preview,/bytes omitted/);
 assert.equal((await stat(path.join(jobs.directory(state.id),'output.tail'))).mode&0o777,0o600);
 const read=await jobs.read({job_id:state.id,offset:512,max_bytes:512});
 assert.equal(read.next_offset,1024);
 assert.equal(read.has_more,false);
 assert.match(read.output_preview,/FINAL_ERROR/);
});

test('output_preview includes end of long log before storage cap and preserves offset',async t=>{
 const {jobs}=await fixture(t);
 const command='process.stdout.write("OPEN\\n"+"-".repeat(600)+"\\nCLOSE\\n")';
 const state=await jobs.start({argv:[process.execPath,'-e',command],wait_ms:5000,max_bytes:256});
 assert.equal(state.status,'succeeded');
 assert.equal(state.log_truncated,false);
 assert.match(state.output_preview,/OPEN/);
 assert.match(state.output_preview,/CLOSE/);
 assert.equal(state.next_offset,256);
 assert.ok(!state.output.includes('CLOSE'));
});
