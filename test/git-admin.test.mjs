import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,stat,symlink,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {GitAdmin} from '../src/git-admin.mjs';

async function fixture(t){
  const root=await mkdtemp(path.join(os.tmpdir(),'scd-gitadmin-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const workspace=path.join(root,'workspace'),home=path.join(root,'runner'),dataRoot=path.join(root,'state');
  await mkdir(workspace);await mkdir(home);await mkdir(dataRoot);
  const config={workspace,executionHome:home,dataRoot,password:'admin-secret',publicBaseURL:'https://example.test'};
  return {...config,root,home,git:new GitAdmin(config)};
}
const git=(cwd,...args)=>{
  const result=spawnSync('/usr/bin/git',args,{cwd,encoding:'utf8',env:{...process.env,HOME:cwd}});
  assert.equal(result.status,0,result.stderr);
  return result.stdout.trim();
};

test('Git Admin uses the execution HOME, persists commit identity and never touches process-global HOME',async t=>{
  const x=await fixture(t);
  const current=await x.git.run('status');
  assert.equal(current.identity.name,'');
  assert.equal(current.profiles.length,0);
  const changed=await x.git.run('identity',{name:'Hs Galaxy',email:'dev@example.org'});
  assert.deepEqual(changed.identity,{name:'Hs Galaxy',email:'dev@example.org'});
  assert.equal((await x.git.run('status')).identity.name,'Hs Galaxy');
  assert.equal(git(x.home,'config','--global','--get','user.email'),'dev@example.org');
  assert.equal((await stat(path.join(x.home,'.gitconfig'))).isFile(),true);
  await assert.rejects(x.git.run('identity',{name:'evil\n[include]',email:'dev@example.org'}),/name/);
  await assert.rejects(x.git.run('identity',{name:'valid',email:'fake\n[credential]'}),/email/);
});

test('repo-specific deploy keys preserve preexisting SSH config and never export private content',async t=>{
  const x=await fixture(t);
  await mkdir(path.join(x.home,'.ssh'),{mode:0o700});
  const mainConfig=path.join(x.home,'.ssh','config');
  const original='Host my-existing-host\n    HostName example.test\n    User git\n';
  await writeFile(mainConfig,original,{mode:0o600});
  const one=await x.git.run('generate',{repository:'HsGalaxy/SuperChatDev'});
  assert.equal(one.ok,true);
  assert.match(one.publicKey,/^ssh-ed25519 AAAA/);
  assert.equal(one.publicKey.includes('PRIVATE KEY'),false);
  assert.match(one.githubDeployKeyURL,/SuperChatDev\/settings\/keys$/);
  const other=await x.git.run('generate',{repository:'Org/other_project'});
  assert.notEqual(one.alias,other.alias);
  const status=await x.git.run('status');
  assert.equal(status.profiles.length,2);
  assert.equal(status.profiles[0].present,true);
  assert.match(status.profiles[0].fingerprint,/^SHA256:/);
  const contents=await readFile(mainConfig,'utf8');
  assert.ok(contents.includes(original));
  assert.equal(contents.match(/^Include /gm).length,1);
  assert.ok(contents.indexOf('Include ')<contents.indexOf(original));
  const managed=await readFile(path.join(x.home,'.ssh','superchatdev-managed.conf'),'utf8');
  assert.match(managed,/StrictHostKeyChecking yes/);
  assert.match(managed,/IdentityAgent none/);
  assert.ok(managed.includes(one.alias));
  assert.ok(managed.includes(other.alias));
  // The Admin-created Include resolves correctly even if the test HOME is
  // different from this machine's passwd home; production uses runner HOME.
  const effective=spawnSync('/usr/bin/ssh',['-F',mainConfig,'-G',one.alias],{encoding:'utf8'});
  assert.equal(effective.status,0,effective.stderr);
  assert.match(effective.stdout,/hostname github\.com/);
  assert.ok(effective.stdout.includes('identityfile '+path.join(x.home,'.ssh','scd-'+one.alias.slice('scd-github-'.length)+'-ed25519')));
  assert.ok(effective.stdout.includes('userknownhostsfile '+path.join(x.home,'.ssh','superchatdev-known_hosts')));
  const listing=await import('node:fs/promises').then(m=>m.readdir(path.join(x.home,'.ssh')));
  const privateNames=listing.filter(n=>n.startsWith('scd-') && n.endsWith('-ed25519'));
  assert.equal(privateNames.length,2);
  for(const filename of privateNames)assert.equal((await stat(path.join(x.home,'.ssh',filename))).mode&0o777,0o600);
  const serialized=JSON.stringify(status)+JSON.stringify(one);
  assert.ok(!serialized.includes('OPENSSH PRIVATE KEY'));
  await assert.rejects(x.git.run('generate',{repository:'hsgalaxy/superchatdev'}),/already exists/);
  await assert.rejects(x.git.run('generate',{repository:'../secrets'}),/Repository/);
  await assert.rejects(x.git.run('generate',{repository:'Org/evil\nHost inject'}),/Repository/);
  const removed=await x.git.run('remove',{repository:'Org/other_project'});
  assert.equal(removed.ok,true);
  assert.equal((await x.git.run('status')).profiles.length,1);
  assert.equal(await readFile(mainConfig,'utf8'),contents);
});

test('adopt an existing runner key without rotating its GitHub registration; validated key import',async t=>{
 const x=await fixture(t),dir=path.join(x.home,'.ssh');
 await mkdir(dir,{mode:0o700});
 const key=path.join(dir,'superchatdev_deploy_ed25519');
 const generated=spawnSync('/usr/bin/ssh-keygen',['-q','-t','ed25519','-N','','-f',key],{encoding:'utf8'});
 assert.equal(generated.status,0,generated.stderr);
 const original=await readFile(key);
 assert.equal((await x.git.run('status')).existingManualKey,true);
 const adopted=await x.git.run('adopt',{repository:'HsGalaxy/SuperChatDev'});
 const after=await x.git.run('status');
 assert.equal(after.profiles.length,1);
 assert.equal(after.profiles[0].publicKey,adopted.publicKey);
 const id=after.profiles[0].alias.slice('scd-github-'.length);
 assert.ok((await readFile(path.join(dir,'scd-'+id+'-ed25519'))).equals(original));
 await x.git.run('remove',{repository:'HsGalaxy/SuperChatDev'});
 assert.ok((await readFile(key)).equals(original));
 const imported=await x.git.run('import',{repository:'Test/example',privateKey:original.toString('utf8')});
 assert.ok(imported.publicKey.startsWith('ssh-ed25519'));
 await assert.rejects(x.git.run('import',{repository:'Test/broken',privateKey:'-----BEGIN OPENSSH PRIVATE KEY-----\ninvalid invalid\n-----END OPENSSH PRIVATE KEY-----'}),/Invalid|key/i);
 assert.equal((await x.git.run('status')).profiles.length,1);
});

test('push remote binding changes only origin pushurl inside a scoped Git worktree',async t=>{
 const x=await fixture(t);
 const project=path.join(x.workspace,'imports','my-app');
 await mkdir(project,{recursive:true});
 git(project,'init','-q');
 git(project,'remote','add','origin','https://github.com/Org/Repo.git');
 await x.git.run('generate',{repository:'Org/Repo'});
 // The E2E test is offline; simulate a previously HTTPS-verified host-key
 // cache. Production creates it from the official GitHub meta API on first bind.
 await writeFile(path.join(x.home,'.ssh','superchatdev-known_hosts'),
   'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestFixtureOnlyDoNotUseInProduction\n',{mode:0o600});
 const result=await x.git.run('bind',{repository:'Org/Repo',cwd:'imports/my-app'});
 assert.equal(result.ok,true);
 assert.equal(result.cwd,'imports/my-app');
 assert.match(result.pushUrl,/^git@scd-github-/);
 assert.equal(git(project,'remote','get-url','origin'),'https://github.com/Org/Repo.git');
 assert.equal(git(project,'remote','get-url','--push','origin'),result.pushUrl);
 await assert.rejects(x.git.run('bind',{repository:'Org/Repo',cwd:'../../etc'}),/workspace|path/i);
 await assert.rejects(x.git.run('bind',{repository:'Org/Repo',cwd:'.'}),/workspace|path/i);
 const outside=path.join(x.root,'outside');await mkdir(outside);
 await symlink(outside,path.join(x.workspace,'evil'));
 await assert.rejects(x.git.run('bind',{repository:'Org/Repo',cwd:'evil'}),/workspace/i);
 await assert.rejects(x.git.run('bind',{repository:'Other/repo',cwd:'imports/my-app'}),/No SSH/);
});

test('concurrent SSH key creation serializes and prevents overwrites',async t=>{
 const x=await fixture(t);
 const results=await Promise.allSettled([
   x.git.run('generate',{repository:'Same/repo'}),
   x.git.run('generate',{repository:'Same/repo'})
 ]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.filter(r=>r.status==='rejected').length,1);
 assert.equal((await x.git.run('status')).profiles.length,1);
});
