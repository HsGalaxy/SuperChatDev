import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {guideTool} from '../src/guidance.mjs';
import {fileTools} from '../src/files.mjs';
import {codeTools} from '../src/code-tools.mjs';
import {jobTools} from '../src/jobs.mjs';
import {workspaceTools} from '../src/workspace.mjs';
import {reviewTool} from '../src/review.mjs';
const dirname=path.dirname(fileURLToPath(import.meta.url));
const core=[guideTool,...fileTools,...codeTools,...jobTools,...workspaceTools,reviewTool];
const names=['dev_get_guide','file_import','file_unpack','file_export','fs_list','fs_read','fs_search','job_start','job_read','job_list','job_cancel','workspace_execute','workspace_read','workspace_list','workspace_cancel','workspace_review'];
const byName=new Map(core.map(t=>[t.name,t]));
const hash=t=>createHash('sha256').update(JSON.stringify({inputSchema:t.inputSchema,fileParams:t._meta?.['openai/fileParams']||[],annotations:t.annotations||{}})).digest('hex');
test('frozen core API matches published client schema',async()=>{
  assert.deepEqual([...byName.keys()],names);
  assert.equal(byName.size,core.length);
  const snap=JSON.parse(await readFile(path.join(dirname,'contracts/core-tools-v0.3.0.json'),'utf8'));
  assert.deepEqual(Object.fromEntries(names.map(n=>[n,hash(byName.get(n))])),snap.hashes,'Changed schema: coordinate client action refresh before shipping');
});
test('ChatGPT attachment and development handoff contracts are explicit',()=>{
  assert.deepEqual(byName.get('file_import')._meta['openai/fileParams'],['file']);
  assert.ok('file' in byName.get('file_import').inputSchema.properties);
  assert.ok('path' in byName.get('file_export').inputSchema.properties);
  assert.ok('request_id' in byName.get('job_start').inputSchema.properties);
  assert.ok('wait_ms' in byName.get('job_start').inputSchema.properties);
  assert.ok('cwd' in byName.get('workspace_execute').inputSchema.properties);
  assert.ok('expected_sha256' in byName.get('fs_read').inputSchema.properties.files.items.properties);
  assert.ok('steps' in byName.get('workspace_execute').inputSchema.properties);
});
test('web schemas are bounded, strict and duplicate-free',()=>{
 for(const t of core){
  assert.equal(t.inputSchema.type,'object',t.name);
  assert.equal(t.inputSchema.additionalProperties,false,t.name);
  assert.ok(t.annotations,t.name);
  assert.ok(Buffer.byteLength(JSON.stringify(t))<24000,t.name+' tool description too large');
 }
});
