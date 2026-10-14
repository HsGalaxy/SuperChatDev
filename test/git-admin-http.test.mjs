import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,stat,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createApp} from '../src/server.mjs';

test('Git Admin HTTP endpoints are session/CSRF/password protected and never return SSH private material',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'scd-admin-git-http-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const workspace=path.join(root,'workspace'),dataRoot=path.join(root,'state'),home=path.join(root,'runner');
  await Promise.all([mkdir(workspace),mkdir(dataRoot),mkdir(home)]);
  const config={workspace,dataRoot,executionHome:home,password:'test-admin-pass',
    publicBaseURL:'https://dev.example',httpOrigins:['https://dev.example']};
  const app=await createApp(config);
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>app.server.close(resolve)));
  const base='http://127.0.0.1:'+app.server.address().port+'/admin';
  const call=async (endpoint,method='GET',data,headers={})=>{
    const r=await fetch(base+endpoint,{method,headers:{...headers,...(data!==undefined?{'Content-Type':'application/json'}:{})},
      ...(data!==undefined?{body:JSON.stringify(data)}:{})});
    return {status:r.status,text:await r.text(),cookie:r.headers.get('set-cookie')};
  };
  const loggedOut=await call('/api/git');
  assert.equal(loggedOut.status,401);
  const login=await call('/api/login','POST',{password:'test-admin-pass'});
  assert.equal(login.status,200);
  const Cookie=login.cookie.split(';')[0];
  const headers={Cookie};
  const session=JSON.parse((await call('/api/session','GET',undefined,headers)).text);
  assert.equal(session.authenticated,true);
  const authorized={Cookie,'X-CSRF-Token':session.csrf};
  assert.equal((await call('/api/git/identity','POST',{name:'test',email:'test@example.org'},headers)).status,403);
  assert.equal((await call('/api/git/import','POST',{repository:'Org/repo',privateKey:'secret'},authorized)).status,403);
  assert.equal((await call('/api/git/adopt','POST',{repository:'Org/repo'},authorized)).status,403);
  assert.equal((await call('/api/git/remove','POST',{repository:'Org/repo'},authorized)).status,403);
  const identity=await call('/api/git/identity','POST',{name:'Test Developer',email:'test@example.org'},authorized);
  assert.equal(identity.status,200,identity.text);
  const initial=JSON.parse((await call('/api/git','GET',undefined,headers)).text);
  assert.equal(initial.identity.name,'Test Developer');
  assert.equal(initial.profiles.length,0);
  const created=await call('/api/git/generate','POST',{repository:'Org/repo'},authorized);
  assert.equal(created.status,200,created.text);
  const publicResult=JSON.parse(created.text);
  assert.ok(publicResult.publicKey.startsWith('ssh-ed25519 '));
  assert.ok(!created.text.includes('OPENSSH PRIVATE KEY'));
  const state=JSON.parse((await call('/api/git','GET',undefined,headers)).text);
  assert.equal(state.profiles.length,1);
  assert.equal(state.profiles[0].repository,'Org/repo');
  assert.equal(state.profiles[0].present,true);
  const badImport='-----BEGIN OPENSSH PRIVATE KEY-----\n'+('SENSITIVE-SECRET-XYZ'.repeat(10))+'\n-----END OPENSSH PRIVATE KEY-----';
  const broken=await call('/api/git/import','POST',{
    repository:'Org/broken',password:'test-admin-pass',privateKey:badImport
  },authorized);
  assert.equal(broken.status,400);
  assert.ok(!broken.text.includes('SENSITIVE-SECRET-XYZ'));
  const audit=await readFile(path.join(dataRoot,'admin-audit.jsonl'),'utf8');
  assert.ok(audit.includes('git.generate')&&audit.includes('git.identity'));
  assert.ok(!audit.includes('Org/repo')&&!audit.includes('PRIVATE KEY')&&!audit.includes('Test Developer'));
  const bad=await call('/api/git/remove','POST',{repository:'Org/repo',password:'wrong'},authorized);
  assert.equal(bad.status,403);
  const deleted=await call('/api/git/remove','POST',{repository:'Org/repo',password:'test-admin-pass'},authorized);
  assert.equal(deleted.status,200,deleted.text);
  const empty=JSON.parse((await call('/api/git','GET',undefined,headers)).text);
  assert.equal(empty.profiles.length,0);
  const page=await call('/');
  assert.equal(page.status,200);
  assert.ok(page.text.includes('id="page-git"'));
});

test('Git admin remains inaccessible when the administrator feature is disabled',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'scd-git-admin-disabled-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const workspace=path.join(root,'work'),dataRoot=path.join(root,'state'),home=path.join(root,'home');
 await Promise.all([mkdir(workspace),mkdir(dataRoot),mkdir(home)]);
 const app=await createApp({workspace,dataRoot,executionHome:home,bearerToken:'token-for-tests'});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>app.server.close(resolve)));
 const base='http://127.0.0.1:'+app.server.address().port;
 assert.equal((await fetch(base+'/admin/api/git')).status,404);
 assert.equal((await fetch(base+'/health')).status,200);
});
