import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {createApp} from '../src/server.mjs';
import {parseDevelopmentLog,readDevelopmentLog} from '../src/development-log.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('release Markdown parser supports releases, upcoming notes and multiline bullets',()=>{
 const content=['# Changelog','## 0.3.10 — Development Log page',
  '- **NEW** release viewer','  with follow-up detail','## Unreleased — future',
  '- planned','## 0.3.9 — Previous','- works'].join('\n');
 const entries=parseDevelopmentLog(content);
 assert.equal(entries.length,3);
 assert.deepEqual(entries.map(e=>e.kind),['release','unreleased','release']);
 assert.equal(entries[0].version,'0.3.10');
 assert.equal(entries[0].title,'Development Log page');
 assert.match(entries[0].items[0],/follow-up detail/);
 assert.throws(()=>parseDevelopmentLog('x'.repeat(300*1024)),/too large/);
});

test('installed changelog is the single source of release notes',async()=>{
 const data=await readDevelopmentLog();
 const pkg=JSON.parse(await readFile(path.join(ROOT,'package.json'),'utf8'));
 assert.equal(data.version,pkg.version);
 assert.equal(data.source,'CHANGELOG.md');
 assert.ok(data.release_count>=6);
 assert.ok(data.entries.some(x=>x.version===data.version));
 assert.ok(data.entries.some(x=>x.kind==='unreleased'));
});

test('release-note renderer escapes markup before highlighting Markdown',async()=>{
 const src=await readFile(path.join(ROOT,'web/admin.js'),'utf8');
 const match=src.match(/function devlogInline\(value\)\s*\{[\s\S]*?\n\}/);
 assert.ok(match);
 const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const inline=vm.runInNewContext(match[0]+';devlogInline',{esc});
 const text=inline('<img src=x onerror="alert(1)"> **Feature** '+String.fromCharCode(96)+'test'+String.fromCharCode(96));
 assert.doesNotMatch(text,/<img/);
 assert.match(text,/&lt;img/);
 assert.match(text,/<strong>Feature<\/strong>/);
 assert.match(text,/<code>test<\/code>/);
});

test('Admin development log route is authenticated, read-only and available in sidebar',async t=>{
 const temp=await mkdtemp(path.join(os.tmpdir(),'scd-devlog-test-'));
 const workspace=path.join(temp,'workspace'),dataRoot=path.join(temp,'state');
 await Promise.all([mkdir(workspace),mkdir(dataRoot)]);
 const app=await createApp({workspace,dataRoot,password:'devlog-private-test',bearerToken:'devlog-only-test'});
 await new Promise(ok=>app.server.listen(0,'127.0.0.1',ok));
 t.after(async()=>{app.server.closeAllConnections();await new Promise(ok=>app.server.close(ok));await rm(temp,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+app.server.address().port;
 assert.equal((await fetch(base+'/admin/api/development-log')).status,401);
 const html=await (await fetch(base+'/admin/')).text();
 assert.match(html,/data-nav="devlog"/);
 assert.match(html,/id="page-devlog"/);
 const login=await fetch(base+'/admin/api/login',{method:'POST',
  headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'devlog-private-test'})});
 assert.equal(login.status,200);
 const cookie=login.headers.get('set-cookie').split(';')[0];
 const response=await fetch(base+'/admin/api/development-log',{headers:{Cookie:cookie}});
 assert.equal(response.status,200);
 assert.equal(response.headers.get('cache-control'),'no-store');
 const data=await response.json();
 assert.equal(data.version,'0.3.12');
 assert.ok(data.entries.length>=8);
 assert.ok(data.entries.some(e=>e.version==='0.3.10' && e.items.some(x=>x.includes('Development Log'))));
 assert.notEqual((await fetch(base+'/admin/api/development-log',{method:'POST',headers:{Cookie:cookie}})).status,200);
});

test('release integrity records new changelog source',async()=>{
 const manifest=JSON.parse(await readFile(path.join(ROOT,'RELEASE.json'),'utf8'));
 assert.equal(manifest.version,'0.3.12');
 assert.match(manifest.files['CHANGELOG.md'],/^[a-f0-9]{64}$/);
 assert.match(manifest.files['src/development-log.mjs'],/^[a-f0-9]{64}$/);
});
