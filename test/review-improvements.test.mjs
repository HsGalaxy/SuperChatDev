import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parsePatch,applyHunks} from '../src/patch.mjs';
import {CodeTools} from '../src/code-tools.mjs';

test('relocates a patch with wrong line coordinates only on exact unique context', () => {
 const patch='--- a/a.txt\n+++ b/a.txt\n@@ -6,1 +6,1 @@\n-old\n+new\n';
 const result=applyHunks('top\nold\nend\n',parsePatch(patch)[0]);
 assert.equal(result,'top\nnew\nend\n');
});

test('off-by-one counts accepted when actual hunk is self-consistent', () => {
 const patch='--- a/a.txt\n+++ b/a.txt\n@@ -2,2 +2,2 @@\n-old\n+new\n';
 const result=applyHunks('top\nold\nend\n',parsePatch(patch)[0]);
 assert.equal(result,'top\nnew\nend\n');
});

test('ambiguous relocation refuses to change a file', () => {
 const patch='--- a/a.txt\n+++ b/a.txt\n@@ -4,1 +4,1 @@\n-duplicate\n+changed\n';
 assert.throws(()=>applyHunks('duplicate\nbetween\nduplicate\nend\n',parsePatch(patch)[0]),/matches=2/);
});

test('insertion without old context never guesses new position', () => {
 const patch='--- a/a.txt\n+++ b/a.txt\n@@ -99,0 +99,1 @@\n+insert\n';
 assert.throws(()=>applyHunks('first\nsecond\n',parsePatch(patch)[0]),/Ambiguous zero-context insertion/);
});

test('fs_search supports path globs and +/-2 context; fs_read offers path hint', async t => {
 const root=await mkdtemp(path.join(os.tmpdir(),'superchatdev-search-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(path.join(root,'project','src','nested'),{recursive:true});
 await writeFile(path.join(root,'project','src','nested','demo.mjs'),'a\nbefore\nlet important = 42;\nafter\nz\n');
 await writeFile(path.join(root,'project','src','nested','demo.ts'),'let important = 100;\n');
 const code=new CodeTools({workspace:root});
 const data=await code.search({cwd:'project',query:'important',glob:'src/**/*.mjs'});
 assert.equal(data.matches.length,1);
 assert.equal(data.matches[0].path,'src/nested/demo.mjs');
 assert.deepEqual(data.matches[0].context.map(x=>x.line),[1,2,3,4,5]);
 const wrong=await code.read({cwd:'project',files:[{path:'project/src/nested/demo.mjs'}]});
 assert.match(wrong.files[0].error,/Path includes cwd prefix/);
 assert.match(wrong.files[0].error,/src\/nested\/demo.mjs/);
});
