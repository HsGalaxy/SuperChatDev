import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,stat,writeFile,chmod} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {createApp} from '../src/server.mjs';
import {CloudflareTunnel,validateHostname} from '../src/cloudflare-tunnel.mjs';

const runToken='eyJ'+('A'.repeat(128));
const apiToken='cloudflareApiToken_'+('B'.repeat(36));
const accountId='a'.repeat(32),zoneId='b'.repeat(32);
const tunnelId='11111111-2222-4333-8444-555555555555';
async function fixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'scd-cloudflare-test-'));
 const dataRoot=path.join(root,'state'),workspace=path.join(root,'workspace');
 await Promise.all([mkdir(dataRoot),mkdir(workspace)]);
 const binary=path.join(root,'cloudflared');
 const code='#!/usr/bin/env node\n'+
  'if(process.argv.includes("--version")){console.log("cloudflared version 2026.10.0");process.exit(0)}\n'+
  'if(process.argv.includes("--url"))setTimeout(()=>console.error("https://demo-cloud-tunnel.trycloudflare.com"),15);\n'+
  'process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000);\n';
 await writeFile(binary,code,{mode:0o755});await chmod(binary,0o755);
 t.after(()=>rm(root,{recursive:true,force:true}));
 return {root,dataRoot,workspace,binary,port:18787,publicBaseURL:'https://initial.example.org',httpOrigins:['https://initial.example.org']};
}
const reply=(result,status=200)=>Response.json({success:status<400,result,errors:status<400?[]:[{message:'Duplicate DNS record'}]},{status});
function apiMock({dnsFailure=false}={}){
 const actions=[];
 const fn=async(url,opts={})=>{
  if(url.endsWith('/health'))return new Response('{"ok":true}',{status:200});
  assert.ok(url.startsWith('https://api.cloudflare.com/client/v4/'));
  assert.equal(opts.headers.Authorization,'Bearer '+apiToken);
  const method=opts.method;
  actions.push({url,method,body:opts.body?JSON.parse(opts.body):null});
  if(method==='POST'&&url.endsWith('/cfd_tunnel'))
   return reply({id:tunnelId,token:runToken});
  if(method==='PUT'&&url.endsWith('/configurations'))return reply({ok:true});
  if(method==='POST'&&url.endsWith('/dns_records')){
   if(dnsFailure)return reply(null,409);
   return reply({id:'abcdef1234567890'});
  }
  if(method==='DELETE')return reply({deleted:true});
  throw Error('unexpected mock CF API call');
 };
 return {fn,actions};
}
test('hostname validation rejects URLs, private labels, quick tunnel names and injection',()=>{
 assert.equal(validateHostname('MCP.EXAMPLE.ORG'),'mcp.example.org');
 for(const bad of ['https://attacker.com','localhost','evil.invalid','setup.trycloudflare.com',
  '*.example.org','a'.repeat(64)+'.example.com','evil.example.com:443',
  'a..com','evil.com/health',''])assert.throws(()=>validateHostname(bad));
});
test('no cloudflared is installed or downloaded without explicit opt-in',async t=>{
 const c=await fixture(t),manager=new CloudflareTunnel(c,{binary:path.join(c.root,'absent-cloudflared')});
 await manager.init();
 assert.equal((await manager.status()).installed,false);
 await assert.rejects(manager.quick(),/not installed/);
 assert.equal((await manager.status()).configured,false);
 assert.equal((await manager.status()).requires_binary_install,true);
 await manager.shutdown();
});
test('Quick mode discovers URL, avoids accounts, and clears URL on stop',async t=>{
 const c=await fixture(t),urls=[];
 const manager=new CloudflareTunnel(c,{binary:c.binary,publishBase:u=>urls.push(u),fetch:async()=>new Response('',{status:503})});
 await manager.init();
 try {
 const result=await manager.quick();
 assert.equal(result.mcp_url,'https://demo-cloud-tunnel.trycloudflare.com/mcp');
 assert.equal(result.mode,'quick');
 assert.equal(result.running,true);
 assert.equal(result.token_configured,false);
 assert.equal((await readFile(path.join(c.dataRoot,'cloudflare-tunnel','quick-url'),'utf8')).trim(),result.url);
 const diagnostics=await manager.statusCheck();
 assert.equal(diagnostics.origin.ok,false,'offline origin is diagnosed separately');
 assert.ok(urls.includes(result.url));
 const stopped=await manager.stop();
 assert.equal(stopped.running,false);
 assert.equal(stopped.public_url,null);
 assert.ok(urls.includes(null));
 } finally {await manager.stop({retainProfile:false});}
});
test('manual named tunnel token is in owner-only file and never appears in command args or API results',async t=>{
 const c=await fixture(t),manager=new CloudflareTunnel(c,{binary:c.binary,publishBase:()=>{}});
 await manager.init();
 const result=await manager.saveNamed({hostname:'mcp.example.org',token:runToken});
 assert.equal(result.mode,'named');
 assert.equal(result.hostname,'mcp.example.org');
 assert.equal(result.mcp_url,'https://mcp.example.org/mcp');
 assert.equal(result.autostart,true);
 assert.ok(!JSON.stringify(result).includes(runToken));
 assert.ok(manager.child.spawnargs.includes('--token-file'));
 assert.ok(!manager.child.spawnargs.join(' ').includes(runToken));
 const file=path.join(c.dataRoot,'cloudflare-tunnel','token');
 assert.equal((await stat(file)).mode&0o777,0o600);
 assert.equal((await readFile(file,'utf8')).trim(),runToken);
 const stop=await manager.stop();
 assert.equal(stop.running,false);
 assert.equal(stop.configured,true);
 assert.equal(stop.autostart,false);
 const resumed=await manager.resume();
 assert.equal(resumed.running,true);
 assert.equal(resumed.autostart,true);
 await manager.remove();
 await assert.rejects(stat(file),{code:'ENOENT'});
});
test('named Cloudflare API provisions tunnel ingress, DNS and stored run token',async t=>{
 const c=await fixture(t),mock=apiMock();
 const manager=new CloudflareTunnel(c,{binary:c.binary,fetch:mock.fn});
 await manager.init();
 const s=await manager.createRemote({apiToken,accountId,zoneId,
  name:'superchatdev_test',hostname:'mcp.example.org'});
 assert.equal(s.tunnel_id,tunnelId);
 assert.equal(s.mode,'named');
 assert.equal(s.mcp_url,'https://mcp.example.org/mcp');
 assert.equal(mock.actions.length,3);
 assert.deepEqual(mock.actions.map(x=>x.method),['POST','PUT','POST']);
 assert.equal(mock.actions[0].body.config_src,'cloudflare');
 assert.deepEqual(mock.actions[1].body.config.ingress,[
  {hostname:'mcp.example.org',service:'http://127.0.0.1:18787',originRequest:{}},
  {service:'http_status:404'}
 ]);
 assert.equal(mock.actions[2].body.content,tunnelId+'.cfargotunnel.com');
 assert.equal(mock.actions[2].body.proxied,true);
 assert.ok(!JSON.stringify(s).includes(apiToken));
 assert.ok(!JSON.stringify(s).includes(runToken));
 assert.ok(!(await readFile(path.join(c.dataRoot,'cloudflare-tunnel','profile.json'),'utf8')).includes(apiToken));
 await manager.remove();
});
test('Cloudflare DNS conflict never overwrites existing DNS and cleans only its new tunnel',async t=>{
 const c=await fixture(t),mock=apiMock({dnsFailure:true});
 const manager=new CloudflareTunnel(c,{binary:c.binary,fetch:mock.fn});
 await manager.init();
 await assert.rejects(manager.createRemote({apiToken,accountId,zoneId,
   name:'superchatdev_test',hostname:'mcp.example.org'}),/provisioning failed/);
 assert.deepEqual(mock.actions.map(x=>x.method),['POST','PUT','POST','DELETE']);
 assert.equal((await manager.status()).configured,false);
 await assert.rejects(stat(path.join(c.dataRoot,'cloudflare-tunnel','token')),{code:'ENOENT'});
});
test('malformed Cloudflare token and IDs are rejected before API requests',async t=>{
 const c=await fixture(t),mock=apiMock(),manager=new CloudflareTunnel(c,{binary:c.binary,fetch:mock.fn});
 await manager.init();
 await assert.rejects(manager.createRemote({apiToken:'bad',accountId,zoneId,name:'superchatdev',hostname:'mcp.example.org'}));
 await assert.rejects(manager.createRemote({apiToken,accountId:'bad',zoneId,name:'superchatdev',hostname:'mcp.example.org'}));
 await assert.rejects(manager.saveNamed({hostname:'mcp.example.org',token:'--bad'}));
 assert.equal(mock.actions.length,0);
});
test('saved named tunnel resumes on gateway restart without a Cloudflare API token',async t=>{
 const c=await fixture(t);
 const first=new CloudflareTunnel(c,{binary:c.binary});
 await first.init();await first.saveNamed({hostname:'mcp.example.org',token:runToken,tunnelId});
 await first.stop();await first.shutdown();
 const file=path.join(c.dataRoot,'cloudflare-tunnel','profile.json');
 const profile=JSON.parse(await readFile(file,'utf8'));
 profile.enabled=true;
 await writeFile(file,JSON.stringify(profile),{mode:0o600});
 const second=new CloudflareTunnel(c,{binary:c.binary});
 await second.init();
 const status=await second.status();
 assert.equal(status.mode,'named');
 assert.equal(status.running,true);
 assert.equal(status.hostname,'mcp.example.org');
 await second.remove();
});
test('Cloudflare diagnostics separates healthy origin and tunnel edge from process state',async t=>{
 const c=await fixture(t),called=[];
 const fakeFetch=async(url,options)=>{called.push([url,options.method]);return new Response('',{status:200})};
 const manager=new CloudflareTunnel(c,{binary:c.binary,fetch:fakeFetch});
 await manager.init();await manager.saveNamed({hostname:'mcp.example.org',token:runToken});
 const diagnosis=await manager.statusCheck();
 assert.equal(diagnosis.ready,true);
 assert.equal(diagnosis.origin.ok,true);
 assert.equal(diagnosis.public.ok,true);
 assert.deepEqual(called.map(x=>x[0]),[
  'http://127.0.0.1:18787/health','https://mcp.example.org/health'
 ]);
 await manager.remove();
});
test('Admin control plane enforces login, CSRF and password reconfirmation; dynamic OAuth issuer follows Quick',async t=>{
 const c=await fixture(t);
 const config={...c,password:'owner-password',adminPassword:'admin-password',bearerToken:'app-token',
  tunnelOptions:{binary:c.binary},host:'127.0.0.1'};
 const app=await createApp(config);
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+app.server.address().port;
 t.after(async()=>{
  await app.tunnels.stop({retainProfile:false});
  app.server.closeAllConnections();
  await new Promise(resolve=>app.server.close(resolve));
 });
 const unauthed=await fetch(base+'/admin/api/tunnel');
 assert.equal(unauthed.status,401);
 const login=await fetch(base+'/admin/api/login',{method:'POST',
  headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'admin-password'})});
 assert.equal(login.status,200);
 const Cookie=login.headers.get('set-cookie').split(';')[0];
 const session=await (await fetch(base+'/admin/api/session',{headers:{Cookie}})).json();
 const post=(password,csrf)=>fetch(base+'/admin/api/tunnel/quick',{method:'POST',
  headers:{Cookie,'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':csrf}:{})},
  body:JSON.stringify({password})});
 assert.equal((await post('admin-password')).status,403);
 assert.equal((await post('wrong',session.csrf)).status,403);
 const authorized=await post('admin-password',session.csrf);
 assert.equal(authorized.status,200);
 const tunnel=await authorized.json();
 assert.equal(tunnel.mode,'quick');
 const status=await (await fetch(base+'/admin/api/tunnel',{headers:{Cookie}})).json();
 assert.equal(status.mcp_url,'https://demo-cloud-tunnel.trycloudflare.com/mcp');
 assert.ok(!JSON.stringify(status).includes('app-token'));
 assert.equal(app.oauth.base,'https://demo-cloud-tunnel.trycloudflare.com');
 const wellKnown=await (await fetch(base+'/.well-known/oauth-authorization-server')).json();
 assert.equal(wellKnown.issuer,'https://demo-cloud-tunnel.trycloudflare.com');
 const stop=await fetch(base+'/admin/api/tunnel/stop',{method:'POST',
  headers:{Cookie,'Content-Type':'application/json','X-CSRF-Token':session.csrf},
  body:JSON.stringify({password:'admin-password'})});
 assert.equal(stop.status,200);
 assert.equal(app.oauth.base,'https://initial.example.org');
});
test('fresh install Cloudflare selection and lazy installation are dry-run only by default',()=>{
 const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const installer=path.join(project,'scripts/interactive_installer.py');
 const run=args=>spawnSync('python3',[installer,'--lang','en',...args],{encoding:'utf8',timeout:10000});
 const opt=run(['--install-cloudflared','--dry-run']);
 assert.equal(opt.status,0,opt.stderr);
 assert.match(opt.stdout,/optional cloudflared/);
 const cf=run(['--mode','fresh','--access-method','cloudflare','--dry-run']);
 assert.equal(cf.status,0,cf.stderr);
 assert.match(cf.stdout,/cloudflare/);
 assert.match(cf.stdout,/pending.trycloudflare.com/);
});
