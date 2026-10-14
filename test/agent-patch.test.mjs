import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { parsePatch, applyHunks, applyPatch } from '../src/patch.mjs';

test('line-number-free patch relocates exact unique code and retains CRLF', () => {
 const patch='*** Begin Patch\n*** Update File: a.txt\n@@\n-old line\n+new line\n*** End Patch\n';
 const src='first\r\nold line\r\nlast\r\n';
 assert.equal(applyHunks(src,parsePatch(patch)[0]),'first\r\nnew line\r\nlast\r\n');
});

test('line-number-free patch works on mixed CRLF/LF without altering untouched lines', () => {
 const src='first\r\nchange\nthird\r\n';
 const patch='*** Begin Patch\n*** Update File: a.txt\n@@\n-change\n+altered\n*** End Patch\n';
 assert.equal(applyHunks(src,parsePatch(patch)[0]),'first\r\naltered\nthird\r\n');
});

test('line-number-free repeated old context is rejected, anchor constrains it', () => {
 const src='function a() {\n  old\n}\nfunction b() {\n  old\n}\n';
 const wrong='*** Begin Patch\n*** Update File: a.txt\n@@\n-  old\n+  new\n*** End Patch\n';
 assert.throws(()=>applyHunks(src,parsePatch(wrong)[0]),/Unique agent patch context required/);
 const targeted='*** Begin Patch\n*** Update File: a.txt\n@@ function b() {\n-  old\n+  new\n*** End Patch\n';
 assert.equal(applyHunks(src,parsePatch(targeted)[0]),'function a() {\n  old\n}\nfunction b() {\n  new\n}\n');
 const duplicateAnchor='*** Begin Patch\n*** Update File: a.txt\n@@ old\n-old\n+changed\n*** End Patch\n';
 assert.throws(()=>applyHunks('old\nold\n',parsePatch(duplicateAnchor)[0]),/anchor must appear exactly once/);
});

test('line-number-free Add/Delete File and stale SHA-256 integrate with existing atomic patch executor',async t=>{
 const workspace=await mkdtemp(path.join(os.tmpdir(),'scd-agent-patch-'));
 t.after(()=>rm(workspace,{recursive:true,force:true}));
 await writeFile(path.join(workspace,'example.txt'),'old\r\n');
 const raw=await readFile(path.join(workspace,'example.txt'));
 const sha=createHash('sha256').update(raw).digest('hex');
 const patch='*** Begin Patch\n*** Update File: example.txt\n@@\n-old\n+new\n*** Add File: added.txt\n+created\n*** End Patch\n';
 const applied=await applyPatch({workspace,cwd:'.',step:{patch,expected_sha256:{'example.txt':sha}}});
 assert.equal(applied.ok,true);
 assert.equal(await readFile(path.join(workspace,'example.txt'),'utf8'),'new\r\n');
 assert.equal(await readFile(path.join(workspace,'added.txt'),'utf8'),'created\n');
 await assert.rejects(applyPatch({workspace,cwd:'.',step:{patch,expected_sha256:{'example.txt':sha}}}),/sha256 mismatch/);
 const deleted=await applyPatch({workspace,cwd:'.',step:{patch:'*** Begin Patch\n*** Delete File: added.txt\n*** End Patch\n'}});
 assert.equal(deleted.ok,true);
 await assert.rejects(readFile(path.join(workspace,'added.txt')),{code:'ENOENT'});
});

test('agent parser blocks traversal and malformed constructs',()=>{
 for(const patch of [
 '*** Begin Patch\n*** Add File: ../etc/passwd\n+oops\n*** End Patch\n',
 '*** Begin Patch\n*** Update File: test.txt\n@@\n only-context\n*** End Patch\n',
 '*** Begin Patch\n*** Delete File: a\n+bad\n*** End Patch\n',
 '*** Begin Patch\n*** Add File: a\n+hello\n*** Add File: a\n+bye\n*** End Patch\n',
 ]) assert.throws(()=>parsePatch(patch));
});
