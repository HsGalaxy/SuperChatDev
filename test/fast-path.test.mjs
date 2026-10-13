import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { Jobs } from '../src/jobs.mjs';
import { createApp } from '../src/server.mjs';
import { defaultAdminSettings, validateAdminSettings } from '../src/admin.mjs';

async function fixture(t, extra={}) {
  const root=await mkdtemp(path.join(os.tmpdir(),'mcp-fast-path-'));
  const workspace=path.join(root,'workspace'), dataRoot=path.join(root,'state');
  await mkdir(workspace); await mkdir(dataRoot);
  t.after(()=>rm(root,{recursive:true,force:true}));
  return {workspace,dataRoot,publicBaseURL:'https://dev.example',password:'test-owner',
    bearerToken:'test-bearer',clientRedirectOrigins:['https://client.example'],httpOrigins:[], ...extra};
}

function requestApp(app) {
  return async (url,{method='GET',body,headers={}}={})=>{
    const parsed=new URL(url,'https://dev.example');
    const req=Readable.from(body ? [Buffer.from(body)] : []);
    req.url=parsed.pathname+parsed.search;
    req.method=method;
    req.headers=Object.fromEntries(Object.entries(headers).map(([k,v])=>[k.toLowerCase(),v]));
    req.socket={remoteAddress:'127.0.0.1'};
    return await new Promise((resolve,reject)=>{
      let status=200;const responseHeaders=new Map(), chunks=[];
      const res=new Writable({write(chunk,encoding,cb){chunks.push(Buffer.from(chunk));cb();}});
      res.headersSent=false;
      res.setHeader=(key,val)=>responseHeaders.set(key.toLowerCase(),val);
      res.writeHead=(code,hs={})=>{status=code;res.headersSent=true;
        for(const [key,val] of Object.entries(hs))res.setHeader(key,val);};
      res.on('error',reject);
      res.on('finish',()=>{
        const data=Buffer.concat(chunks);
        resolve({status,headers:responseHeaders,text:()=>data.toString(),json:()=>JSON.parse(data.toString())});
      });
      app.server.emit('request',req,res);
    });
  };
}

const exchange=async(request,client,redirect)=>{
  const verifier='x'.repeat(43);
  const params=new URLSearchParams({client_id:client.client_id,redirect_uri:redirect,response_type:'code',
    code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url')});
  const page=await request('/oauth/authorize?'+params);
  assert.equal(page.status,200);
  const form=page.text().match(/name="form" value="([^"]+)"/)[1];
  const consent=await request('/oauth/authorize',{method:'POST',
    body:new URLSearchParams({form,password:'test-owner'}).toString()});
  assert.equal(consent.status,302);
  const code=new URL(consent.headers.get('location')).searchParams.get('code');
  return request('/oauth/token',{method:'POST',body:new URLSearchParams({
    grant_type:'authorization_code',client_id:client.client_id,redirect_uri:redirect,
    code,code_verifier:verifier}).toString()});
};

test('new fast path: omitted wait_ms returns short successful command output with one call',async t=>{
  const config=await fixture(t);const jobs=new Jobs(config);await jobs.init();
  const started=Date.now();
  const short=await jobs.start({argv:['/bin/sh','-c','printf quick'],timeout_seconds:10,request_id:'fast-01'});
  assert.equal(short.status,'succeeded');
  assert.equal(short.exit_code,0);
  assert.equal(short.output,'quick');
  assert.equal(short.has_more,false);
  assert.ok(Date.now()-started<3000);
  const reused=await jobs.start({argv:['/bin/sh','-c','printf quick'],timeout_seconds:10,request_id:'fast-01'});
  assert.equal(reused.status,'succeeded');
  assert.equal(reused.reused,true);
  assert.equal(reused.output,'quick');
  const slow=await jobs.start({argv:['/bin/sh','-c','sleep 2; printf late'],timeout_seconds:10});
  assert.ok(['queued','running'].includes(slow.status),'long jobs are returned without waiting for exit');
  assert.ok(slow.id);
  await jobs.cancel({job_id:slow.id});
  for(let i=0;i<80;i++){
    const state=await jobs.status(slow.id);
    if(['succeeded','failed','cancelled','interrupted'].includes(state.status))break;
    await new Promise(resolve=>setTimeout(resolve,30));
  }
  assert.equal((await jobs.status(slow.id)).status,'cancelled');
});

test('workspace older admin OAuth settings migrate only the new refresh fields',()=>{
 const current=defaultAdminSettings({allowedOrigins:[]});
 const legacy={...current,oauth:{...current.oauth}};
 delete legacy.oauth.refreshTokensEnabled;
 delete legacy.oauth.refreshTokenDays;
 const migrated=validateAdminSettings(legacy,new Set());
 assert.equal(migrated.oauth.refreshTokensEnabled,true);
 assert.equal(migrated.oauth.refreshTokenDays,30);
 delete legacy.oauth.accessTokenMinutes;
 assert.throws(()=>validateAdminSettings(legacy,new Set()),/Missing OAuth/);
});

test('refresh token is hashed, rotated exactly once, client-bound and survives process restart',async t=>{
 const config=await fixture(t);
 const first=await createApp(config), request=requestApp(first);
 const meta=await request('/.well-known/oauth-authorization-server');
 assert.equal(meta.status,200);
 assert.ok(meta.json().grant_types_supported.includes('refresh_token'));
 const redirect='https://client.example/callback';
 const created=await request('/oauth/register',{method:'POST',body:JSON.stringify({redirect_uris:[redirect]})});
 assert.equal(created.status,201);
 const client=created.json();
 const initial=await exchange(request,client,redirect);
 assert.equal(initial.status,200);
 const tokens=initial.json();
 assert.equal(tokens.expires_in,3600);
 assert.equal(tokens.refresh_token_expires_in,30*86400);
 assert.equal(typeof tokens.refresh_token,'string');
 const persisted=await readFile(path.join(config.dataRoot,'oauth-refresh-tokens.json'),'utf8');
 assert.ok(persisted.includes('"hash"'));
 assert.ok(!persisted.includes(tokens.refresh_token));
 const restarted=await createApp(config), fresh=requestApp(restarted);
 const mcp=async(bearer)=>fresh('/mcp',{method:'POST',
    headers:{Authorization:'Bearer '+bearer,'Content-Type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'ping'})});
 assert.equal((await mcp(tokens.access_token)).status,401,
     'short-lived access tokens do not survive restart by default');
 const refresh=async(raw,clientId=client.client_id)=>fresh('/oauth/token',{method:'POST',
   body:new URLSearchParams({grant_type:'refresh_token',client_id:clientId,refresh_token:raw}).toString()});
 const renewed=await refresh(tokens.refresh_token);
 assert.equal(renewed.status,200);
 assert.equal((await mcp(renewed.json().access_token)).status,200);
 assert.notEqual(renewed.json().refresh_token,tokens.refresh_token);
 assert.equal((await refresh(tokens.refresh_token)).status,400,'old refresh cannot be replayed');
 assert.equal((await refresh(renewed.json().refresh_token,'another-client')).status,400);
 assert.equal((await refresh(renewed.json().refresh_token)).status,200);
 const refreshAtRest=await readFile(path.join(config.dataRoot,'oauth-refresh-tokens.json'),'utf8');
 assert.ok(!refreshAtRest.includes(renewed.json().refresh_token));
 const finalClient=await fresh('/admin/api/login',{method:'POST',body:JSON.stringify({password:'test-owner'})});
 assert.equal(finalClient.status,200);
 const cookie=finalClient.headers.get('set-cookie').split(';')[0];
 const session=(await fresh('/admin/api/session',{headers:{Cookie:cookie}})).json();
 const auth={Cookie:cookie,'X-CSRF-Token':session.csrf};
 assert.equal((await fresh('/admin/api/oauth/tokens/revoke',{method:'POST',headers:auth})).status,200);
 assert.equal((await mcp(renewed.json().access_token)).status,401);
 assert.equal((await refresh(renewed.json().refresh_token)).status,400);
});

test('concurrent refresh race cannot issue twice from the same secret; disable clears persistence',async t=>{
 const config=await fixture(t);
 const app=await createApp(config), req=requestApp(app);
 const redirect='https://client.example/callback';
 const client=(await req('/oauth/register',{method:'POST',body:JSON.stringify({redirect_uris:[redirect]})})).json();
 const first=(await exchange(req,client,redirect)).json();
 const body=new URLSearchParams({grant_type:'refresh_token',client_id:client.client_id,refresh_token:first.refresh_token}).toString();
 const result=await Promise.all([req('/oauth/token',{method:'POST',body}),req('/oauth/token',{method:'POST',body})]);
 assert.deepEqual(result.map(r=>r.status).sort(),[200,400]);
 const login=await req('/admin/api/login',{method:'POST',body:JSON.stringify({password:'test-owner'})});
 const cookie=login.headers.get('set-cookie').split(';')[0];
 const csrf=(await req('/admin/api/session',{headers:{Cookie:cookie}})).json().csrf;
 const headers={Cookie:cookie,'X-CSRF-Token':csrf};
 const existing=(await req('/admin/api/settings',{headers})).json().settings;
 existing.oauth.refreshTokensEnabled=false;
 assert.equal((await req('/admin/api/settings',{method:'PUT',headers,body:JSON.stringify(existing)})).status,200);
 const status=(await req('/admin/api/oauth/status',{headers})).json();
 assert.equal(status.activeRefreshTokens,0);
 const missingFile=await readFile(path.join(config.dataRoot,'oauth-refresh-tokens.json')).then(()=>false,e=>e.code==='ENOENT');
 assert.equal(missingFile,true);
 const notRefreshed=await req('/oauth/token',{method:'POST',body});
 assert.equal(notRefreshed.status,400);
});
