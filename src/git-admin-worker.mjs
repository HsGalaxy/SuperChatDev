import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { chmod, copyFile, link, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicJSON, scopedPath } from './common.mjs';

const home = process.env.HOME || os.homedir();
const workspace = process.env.SCD_GIT_WORKSPACE;
const sshDir = path.join(home, '.ssh');
const registryPath = path.join(sshDir, 'superchatdev-profiles.json');
const managedConfig = path.join(sshDir, 'superchatdev-managed.conf');
const mainConfig = path.join(sshDir, 'config');
const manualKey = path.join(sshDir, 'superchatdev_deploy_ed25519');
const MAX_PROFILES = 20;

function repoSlug(value) {
  if (typeof value !== 'string' || value.length > 170 ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) ||
      value.split('/').some(part => part.startsWith('-') || part === '.' || part === '..' || part.includes('..')))
    throw new Error('Repository must use owner/name with only GitHub-compatible characters');
  return value;
}
function entryFor(repository) {
  const repo = repoSlug(repository);
  const id = createHash('sha256').update(repo.toLowerCase()).digest('hex').slice(0, 24);
  return { repo, id, alias: 'scd-github-' + id, key: path.join(sshDir, 'scd-' + id + '-ed25519') };
}
async function ensureRegular(filename) {
  let info;
  try { info = await lstat(filename); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Refusing non-regular Git configuration file');
  return true;
}
async function ensureSSH() {
  if (!path.isAbsolute(home) || /[\r\n\x00]/.test(home)) throw new Error('Invalid execution HOME');
  let info;
  try { info = await lstat(sshDir); }
  catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(sshDir, {mode:0o700}); info=await lstat(sshDir); }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('SSH directory must not be a symlink');
  await chmod(sshDir,0o700);
}
async function registry() {
  await ensureSSH();
  if (!await ensureRegular(registryPath)) return {version:1,profiles:{}};
  const state=JSON.parse(await readFile(registryPath,'utf8'));
  if (state.version!==1 || !state.profiles || typeof state.profiles!=='object' || Array.isArray(state.profiles))
    throw new Error('Invalid stored Git profile registry');
  if(Object.keys(state.profiles).length>MAX_PROFILES) throw new Error('Too many Git profiles');
  for(const item of Object.values(state.profiles)) entryFor(item.repository);
  return state;
}
function keyFor(state, repository) {
  const e=entryFor(repository);
  const saved=state.profiles[e.repo.toLowerCase()];
  if (!saved) throw new Error('No SSH Deploy Key profile for this repository');
  return {...e,repo:saved.repository};
}
async function run(executable,args,{timeout=12000,allowExit1=false,envExtra={}}={}) {
  return await new Promise((resolve,reject)=>{
    let stdout='', stderr='', ended=false;
    const child=spawn(executable,args,{
      cwd:home, env:{PATH:process.env.PATH||'/usr/bin:/bin',HOME:home,LANG:'C',GIT_TERMINAL_PROMPT:'0',...envExtra},
      stdio:['ignore','pipe','pipe']
    });
    const timer=setTimeout(()=>child.kill('SIGKILL'),timeout);
    const append=(target,part)=>{
      if(target==='stdout')stdout+=part.toString('utf8');
      else stderr+=part.toString('utf8');
      if(stdout.length+stderr.length>32768)child.kill('SIGKILL');
    };
    child.stdout.on('data',c=>append('stdout',c));
    child.stderr.on('data',c=>append('stderr',c));
    child.once('error',err=>{if(!ended){ended=true;clearTimeout(timer);reject(new Error('Git tool could not launch: '+err.code));}});
    child.once('close',code=>{
      if(ended)return;
      ended=true;clearTimeout(timer);
      if(code===0 || (allowExit1 && code===1))resolve({code,stdout,stderr});
      else reject(new Error((stderr||'Git command failed').trim().slice(0,600)));
    });
  });
}
async function readAuthor(field) {
  const result=await run('/usr/bin/git',['config','--global','--get',field],{allowExit1:true});
  return result.code===0?result.stdout.trim():'';
}
async function status() {
  const state=await registry();
  const profiles=[];
  for(const saved of Object.values(state.profiles)){
    const e=entryFor(saved.repository);
    const present=await ensureRegular(e.key) && await ensureRegular(e.key+'.pub');
    let publicKey='',fingerprint='';
    if(present){
      publicKey=(await readFile(e.key+'.pub','utf8')).trim();
      try { fingerprint=(await run('/usr/bin/ssh-keygen',['-lf',e.key+'.pub'])).stdout.trim().split(/\s+/)[1]||''; } catch {}
    }
    profiles.push({repository:saved.repository,alias:e.alias,pushUrl:'git@'+e.alias+':'+saved.repository+'.git',
      publicKey,fingerprint,present,createdAt:saved.createdAt});
  }
  return {identity:{name:await readAuthor('user.name'),email:await readAuthor('user.email')},
    profiles:profiles.sort((a,b)=>a.repository.localeCompare(b.repository)),
    existingManualKey:await ensureRegular(manualKey) && await ensureRegular(manualKey+'.pub'),
    homeLabel:'MCP execution account', authType:'SSH Deploy Key', maxProfiles:MAX_PROFILES};
}
async function identity(input){
  const {name,email}=input;
  if(typeof name!=='string'||name.length>100||!name.trim()||/[\x00-\x1f\x7f]/.test(name))
    throw new Error('Git author name must be 1–100 printable characters');
  if(typeof email!=='string'||email.length>254||!email.trim()||/[\x00-\x20\x7f]/.test(email)||!email.includes('@'))
    throw new Error('Git author email must be a valid address');
  await run('/usr/bin/git',['config','--global','user.name',name.trim()]);
  await run('/usr/bin/git',['config','--global','user.email',email.trim()]);
  return {ok:true,identity:{name:name.trim(),email:email.trim()}};
}
async function validatePublicKey(privateFile) {
  const pub=(await run('/usr/bin/ssh-keygen',['-y','-P','','-f',privateFile],{timeout:10000})).stdout.trim();
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]{60,120}(?:\s.*)?$/.test(pub))
    throw new Error('Only unencrypted ED25519 SSH private keys are supported');
  return pub.split(/\s+/).slice(0,2).join(' ');
}
async function ensureManagedConfig(state){
  // The main SSH config is the user's file. Add one Include at the top, then
  // manage separate host aliases; preserve any existing manually-added hosts.
  const validHome = !/["\r\n\x00]/.test(home);
  if(!validHome)throw new Error('Execution HOME contains unsupported SSH config characters');
  const entries=Object.values(state.profiles).map(saved=>{
    const e=entryFor(saved.repository);
    return 'Host '+e.alias+'\n  HostName github.com\n  User git\n  IdentityFile "'+e.key+'"\n  IdentitiesOnly yes\n  IdentityAgent none\n  PreferredAuthentications publickey\n  StrictHostKeyChecking yes\n  UserKnownHostsFile "'+path.join(sshDir,'superchatdev-known_hosts')+'"\n';
  });
  await atomicWrite(managedConfig,entries.join('\n'),0o600);
  const include='Include "'+managedConfig+'"';
  let previous='';
  if(await ensureRegular(mainConfig))previous=await readFile(mainConfig,'utf8');
  if(previous.length>131072) throw new Error('SSH config too large to update safely');
  if(!previous.split(/\r?\n/).some(line=>line.trim()===include))
    await atomicWrite(mainConfig,include+'\n'+previous,0o600);
}
async function atomicWrite(file,text,mode=0o600){
  if(await ensureRegular(file)){} // reject symlinks before replacing
  const temp=file+'.'+randomUUID()+'.tmp';
  try { await writeFile(temp,text,{flag:'wx',mode});await rename(temp,file); }
  finally {await rm(temp,{force:true});}
}
async function createProfile(input) {
  const repo=repoSlug(input.repository);
  const e=entryFor(repo);
  const state=await registry();
  if(state.profiles[repo.toLowerCase()]) throw new Error('Profile already exists; remove explicitly before replacing the key');
  if(Object.keys(state.profiles).length>=MAX_PROFILES)throw new Error('Git profile limit reached');
  if(await ensureRegular(e.key) || await ensureRegular(e.key+'.pub'))throw new Error('An unmanaged key with the same filename already exists');
  const temp=e.key+'.'+randomUUID()+'.tmp';
  let pub='';
  try {
    if(input.mode==='generate'){
      await run('/usr/bin/ssh-keygen',['-q','-t','ed25519','-a','100','-N','','-C','SuperChatDev '+repo,'-f',temp],{timeout:15000});
      pub=await validatePublicKey(temp);
    }else if(input.mode==='adopt'){
      if(!await ensureRegular(manualKey))throw new Error('Existing manual Deploy Key was not found');
      await copyFile(manualKey,temp,fsConstants.COPYFILE_EXCL);await chmod(temp,0o600);
      pub=await validatePublicKey(temp);
    }else if(input.mode==='import'){
      const secret=input.privateKey;
      if(typeof secret!=='string'||secret.length<80||Buffer.byteLength(secret)>16384||!secret.includes('PRIVATE KEY'))
        throw new Error('Invalid SSH private key input');
      await writeFile(temp,secret,{flag:'wx',mode:0o600});
      pub=await validatePublicKey(temp);
    }else throw new Error('Unknown key action');
    await link(temp,e.key);
    await writeFile(e.key+'.pub',pub+'\n',{flag:'wx',mode:0o644});
    state.profiles[repo.toLowerCase()]={repository:repo,createdAt:new Date().toISOString()};
    try {await ensureManagedConfig(state);await atomicJSON(registryPath,state);}
    catch(error){await rm(e.key,{force:true});await rm(e.key+'.pub',{force:true});throw error;}
  }finally {
    await rm(temp,{force:true});await rm(temp+'.pub',{force:true});
  }
  return {ok:true,repository:repo,publicKey:pub,alias:e.alias,
    githubDeployKeyURL:'https://github.com/'+repo+'/settings/keys',
    note:'Add this public key to the GitHub repository and enable Allow write access; write permission cannot be inferred from authentication.'};
}
async function removeProfile(input){
  const state=await registry();
  const e=keyFor(state,input.repository);
  delete state.profiles[e.repo.toLowerCase()];
  await ensureManagedConfig(state);
  await atomicJSON(registryPath,state);
  await rm(e.key,{force:true});await rm(e.key+'.pub',{force:true});
  return {ok:true,repository:e.repo,warning:'Previously configured push URLs will stop working until rebound.'};
}
async function officialKnownHost({refresh=false}={}) {
  const knownHosts=path.join(sshDir,'superchatdev-known_hosts');
  // Setup is automatically performed before binding a push URL. A user must
  // not be forced to run a separate manual SSH host-key acceptance command.
  if(!refresh && await ensureRegular(knownHosts))return;
  const url='https://api.github.com/meta';
  const response=await fetch(url,{headers:{'User-Agent':'SuperChatDev-Git-Admin','Accept':'application/vnd.github+json'},
    signal:AbortSignal.timeout(7000)});
  if(!response.ok) throw new Error('Unable to retrieve official GitHub SSH host keys via HTTPS');
  const json=await response.json();
  const keys=json.ssh_keys?.filter(x=>/^ssh-ed25519 [A-Za-z0-9+/=]+$/.test(x))||[];
  if(keys.length!==1) throw new Error('Unexpected official GitHub SSH host-key response');
  await atomicWrite(knownHosts,'github.com '+keys[0]+'\n',0o600);
}
async function testConnection(input) {
  const state=await registry(),e=keyFor(state,input.repository);
  if(!await ensureRegular(e.key))throw new Error('SSH Deploy Key missing');
  await officialKnownHost({refresh:true});
  try{
    await run('/usr/bin/git',['ls-remote','git@'+e.alias+':'+e.repo+'.git','HEAD'],{timeout:15000});
    return {ok:true,authenticated:true,repositoryReadable:true,pushPermissionVerified:false,
      note:'SSH authentication and repository read succeeded. Write permission requires Allow write access and a real git push.'};
  }catch(error){
    return {ok:false,authenticated:false,repositoryReadable:false,pushPermissionVerified:false,
      error:error.message.slice(0,400)};
  }
}
async function bindRepository(input) {
  const state=await registry(),e=keyFor(state,input.repository);
  if(typeof input.cwd!=='string'||input.cwd.length>260||!workspace)throw new Error('Provide a workspace-relative Git project path');
  const dir=await scopedPath(workspace,input.cwd,{allowRoot:false});
  const toplevel=(await run('/usr/bin/git',['-C',dir,'rev-parse','--show-toplevel'])).stdout.trim();
  if(!toplevel || !toplevel.startsWith(workspace+path.sep))throw new Error('Git repository must reside inside the workspace');
  await run('/usr/bin/git',['-C',dir,'remote','get-url','origin']);
  // Auto-provision the HTTPS-verified GitHub host key before changing pushurl.
  // If the verification source is unavailable, leave the original remote alone.
  await officialKnownHost();
  const pushUrl='git@'+e.alias+':'+e.repo+'.git';
  await run('/usr/bin/git',['-C',dir,'remote','set-url','--push','origin',pushUrl]);
  return {ok:true,cwd:path.relative(workspace,dir),repository:e.repo,pushUrl,
    note:'Only origin push URL changed; fetch URL, commits and source files were untouched.'};
}

const chunks=[];let total=0;
for await(const chunk of process.stdin){
  total+=chunk.length;
  if(total>20000)throw new Error('Git Admin request exceeds 20 KiB');
  chunks.push(chunk);
}
try {
  const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const routes={
    status:status,identity:()=>identity(body),
    generate:()=>createProfile({...body,mode:'generate'}),
    adopt:()=>createProfile({...body,mode:'adopt'}),
    import:()=>createProfile({...body,mode:'import'}),
    remove:()=>removeProfile(body),test:()=>testConnection(body),bind:()=>bindRepository(body)
  };
  if(!Object.hasOwn(routes,body.action)) throw new Error('Unsupported Git Admin action');
  const answer=await routes[body.action]();
  process.stdout.write(JSON.stringify({ok:true,result:answer})+'\n');
}catch(error){
  // No private key content, tokens, or request bodies are logged or returned.
  process.stdout.write(JSON.stringify({ok:false,error:String(error.message).slice(0,650)})+'\n');
  process.exitCode=1;
}
