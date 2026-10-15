import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {CodeTools} from '../src/code-tools.mjs';
import {createApp} from '../src/server.mjs';
import {spawnSync} from 'node:child_process';
const rg='/var/lib/chatgpt-dev-mcp/workspace/desktop-commander-audit-20261015/node_modules/@vscode/ripgrep/bin/rg';
const hasRg=spawnSync(rg,['--version'],{encoding:'utf8'}).status===0;
async function fixture(t){
  const root=await mkdtemp(path.join(os.tmpdir(),'scd-large-project-'));
  const workspace=path.join(root,'work'),dataRoot=path.join(root,'data');
  await Promise.all([mkdir(workspace),mkdir(dataRoot)]);
  t.after(()=>rm(root,{recursive:true,force:true}));
  return {workspace,dataRoot,rgPath:rg};
}
test('large UTF-8 log supports middle range without loading entire file',async t=>{
 const c=await fixture(t),code=new CodeTools(c);
 const text=Array.from({length:220000},(_,i)=>'record '+i+' = 测试').join('\n')+'\n';
 assert.ok(Buffer.byteLength(text)>4*1024*1024);
 await writeFile(path.join(c.workspace,'events.log'),text);
 const result=(await code.read({files:[{path:'events.log',start_line:200000,line_count:3}]})).files[0];
 assert.equal(result.read_only_window,true,JSON.stringify(result).slice(0,800));
 assert.equal(result.sha256,null);
 assert.match(result.numbered_text,/200000: record 199999/);
 assert.match(result.numbered_text,/200002: record 200001/);
 assert.ok(result.scanned_bytes<20*1024*1024);
 const tail=(await code.read({files:[{path:'events.log',tail_lines:2}]})).files[0];
 assert.match(tail.numbered_text,/record 219999/);
 const rejected=(await code.read({files:[{path:'events.log',start_line:200000,expected_sha256:'a'.repeat(64)}]})).files[0];
 assert.match(rejected.error,/cannot validate full-file SHA-256/);
});
test('large log with symlink path is rejected, not followed',async t=>{
 const c=await fixture(t),code=new CodeTools(c);
 await writeFile(path.join(c.dataRoot,'private.log'),'password');
 await symlink(c.dataRoot,path.join(c.workspace,'shortcut'));
 const r=(await code.read({files:[{path:'shortcut/private.log',start_line:1}]})).files[0];
 assert.ok(r.error);
 assert.ok(!r.numbered_text);
});
test('opt-in ripgrep content and filenames honor gitignore and secrets', {skip:!hasRg},async t=>{
 const c=await fixture(t),code=new CodeTools(c);
 await mkdir(path.join(c.workspace,'src'),{recursive:true});
 await mkdir(path.join(c.workspace,'vendor'));
 await writeFile(path.join(c.workspace,'src','one.ts'),'const fruit = "banana";\n');
 await writeFile(path.join(c.workspace,'src','second.ts'),'banana\n');
 await writeFile(path.join(c.workspace,'vendor','ignored.ts'),'banana\n');
 await writeFile(path.join(c.workspace,'.gitignore'),'vendor/\n');
 await writeFile(path.join(c.workspace,'.env'),'banana\n');
 const search=await code.search({query:'banana',engine:'ripgrep',limit:10});
 assert.equal(search.engine,'ripgrep');
 assert.deepEqual(search.matches.map(x=>x.path).sort(),['src/one.ts','src/second.ts']);
 assert.equal(search.search_complete,true);
 const files=await code.search({query:'*.ts',engine:'ripgrep',search_type:'files',limit:10});
 assert.deepEqual(files.matches.map(x=>x.path).sort(),['src/one.ts','src/second.ts']);
 const page=await code.search({query:'banana',engine:'ripgrep',limit:1});
 assert.equal(page.matches.length,1);
 assert.ok(page.next_cursor);
 const second=await code.search({query:'banana',engine:'ripgrep',limit:1,cursor:page.next_cursor});
 assert.equal(second.matches.length,1);
 assert.notEqual(second.matches[0].path,page.matches[0].path);
});
test('Core remains 17 tools, native-interactive provides only local PTY input',async t=>{
 const c=await fixture(t),app=await createApp({...c,bearerToken:'test-token'});
 t.after(()=>app.server.close());
 assert.equal(app.catalog().visible_tools.length,17);
 app.admin.settings.toolProfile='native-interactive';
 assert.equal(app.catalog().visible_tools.length,18);
 assert.equal(app.admin.allowed('job_input'),true);
 assert.ok(app.catalog().visible_tools.includes('job_input'));
 assert.equal(app.catalog().visible_tools.some(x=>x.startsWith('start_process')),false);
});

test('guarded rename_directory works and blocks stale inode, clobber, symlinks',async t=>{
 const c=await fixture(t);
 const {Jobs}=await import('../src/jobs.mjs');
 const {Workspace}=await import('../src/workspace.mjs');
 const {stat}=await import('node:fs/promises');
 const jobs=new Jobs(c);await jobs.init();
 const batches=new Workspace(c,jobs);await batches.init();
 const src=path.join(c.workspace,'old');
 await mkdir(src);await writeFile(path.join(src,'mod.ts'),'export const answer=42;\n');
 const ino=(await stat(src)).ino;
 const result=await batches.execute({wait_ms:10000,steps:[{
   type:'rename_directory',source:'old',destination:'new',expected_inode:ino
 }]});
 assert.equal(result.status,'succeeded',JSON.stringify(result).slice(0,1200));
 assert.equal(await readFile(path.join(c.workspace,'new','mod.ts'),'utf8'),'export const answer=42;\n');
 await assert.rejects(stat(src),{code:'ENOENT'});
 await mkdir(src);await writeFile(path.join(src,'other.ts'),'old');
 const source2=(await stat(src)).ino;
 const blocked=await batches.execute({wait_ms:10000,steps:[{
   type:'rename_directory',source:'old',destination:'new',expected_inode:source2
 }]});
 assert.equal(blocked.status,'failed','must refuse nonempty destination overwrite');
 assert.equal(await readFile(path.join(src,'other.ts'),'utf8'),'old');
 const stale=await batches.execute({wait_ms:10000,steps:[{
   type:'rename_directory',source:'old',destination:'somewhere',expected_inode:ino
 }]});
 assert.equal(stale.status,'failed','source inode must match current');
 await symlink(path.join(c.workspace,'new','mod.ts'),path.join(src,'evil-symlink'));
 const linked=await batches.execute({wait_ms:10000,steps:[{
   type:'rename_directory',source:'old',destination:'somewhere',expected_inode:source2
 }]});
 assert.equal(linked.status,'failed','source subtree containing symlink must be rejected');
 assert.equal(await readFile(path.join(src,'other.ts'),'utf8'),'old');
});

test('ripgrep reports missing system binary and never silently falls back',async t=>{
 const c=await fixture(t);
 const code=new CodeTools({...c,rgPath:'/usr/bin/nonexistent-superchatdev-rg'});
 await writeFile(path.join(c.workspace,'test.ts'),'hello\n');
 await assert.rejects(code.search({query:'hello',engine:'ripgrep'}),/ripgrep is not installed/);
 const native=await code.search({query:'hello'});
 assert.equal(native.matches.length,1);
});
test('ripgrep protects sensitive paths against user-supplied positive globs', {skip:!hasRg},async t=>{
 const c=await fixture(t),code=new CodeTools(c);
 await writeFile(path.join(c.workspace,'.env'),'searchtoken\n');
 await writeFile(path.join(c.workspace,'allowed.ts'),'searchtoken\n');
 await writeFile(path.join(c.workspace,'allowed.key'),'searchtoken\n');
 await mkdir(path.join(c.workspace,'node_modules'));
 await writeFile(path.join(c.workspace,'node_modules','extra.ts'),'searchtoken\n');
 const answer=await code.search({query:'searchtoken',glob:'**/*',engine:'ripgrep'});
 assert.deepEqual(answer.matches.map(x=>x.path),['allowed.ts']);
 await writeFile(path.join(c.workspace,'camelCase.TS'),'hello\n');
 const names=await code.search({query:'*.ts',search_type:'files',engine:'ripgrep',case_sensitive:false});
 assert.ok(names.matches.some(x=>x.path==='camelCase.TS'));
});
test('bounded window never claims a full SHA or loops on unreachable line offset',async t=>{
 const c=await fixture(t),code=new CodeTools(c);
 await writeFile(path.join(c.workspace,'long.log'),'header\n'+('abcdefghijklmnopqrstuvwxyz\n'.repeat(200000)));
 const win=await code.reader.window('.','long.log',190000,2,1024);
 assert.equal(win.scan_limited,true);
 assert.equal(win.sha256,null);
 assert.equal(win.lines.length,0);
});
