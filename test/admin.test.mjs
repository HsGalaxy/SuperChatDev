import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Readable, Writable } from 'node:stream';
import { AdminFiles } from '../src/admin-files.mjs';
import { defaultAdminSettings, validateAdminSettings } from '../src/admin.mjs';
import { createApp } from '../src/server.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-admin-test-'));
  const workspace = path.join(root, 'workspace'), dataRoot = path.join(root, 'state');
  await mkdir(workspace); await mkdir(dataRoot);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, workspace, dataRoot, publicBaseURL: 'https://dev.example', password: 'admin-secret',
    bearerToken: 'test-bearer', httpOrigins: ['https://dev.example'], clientRedirectOrigins: [],
    allowedOrigins: ['https://files.oaiusercontent.com'], maxFileBytes: 512 * 1024 * 1024,
    maxResourceBytes: 8 * 1024 * 1024, maxJobs: 4, host: '127.0.0.1', port: 8787 };
}

function requestApp(app) {
  return async (url, { method = 'GET', body, headers = {} } = {}) => {
    const parsed = new URL(url, 'https://dev.example');
    const req = Readable.from(body ? [Buffer.isBuffer(body) ? body : Buffer.from(body)] : []);
    req.url = parsed.pathname + parsed.search;
    req.method = method;
    req.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    req.socket = { remoteAddress: '127.0.0.1' };
    return await new Promise((resolve, reject) => {
      let status = 200;
      const allHeaders = new Map(), chunks = [];
      const res = new Writable({ write(chunk, _encoding, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
      res.headersSent = false;
      res.setHeader = (key, val) => allHeaders.set(key.toLowerCase(), val);
      res.writeHead = (code, hs = {}) => {
        status = code;
        res.headersSent = true;
        for (const [key, val] of Object.entries(hs)) res.setHeader(key, val);
      };
      res.on('error', reject);
      res.on('finish', () => {
        const output = Buffer.concat(chunks);
        resolve({ status, headers: allHeaders, buffer: output, text: () => output.toString('utf8'), json: () => JSON.parse(output.toString('utf8')) });
      });
      app.server.emit('request', req, res);
    });
  };
}

test('settings validation rejects unknown tools, malformed URLs and invalid limits', () => {
  const config = { maxJobs: 4, allowedOrigins: ['https://files.oaiusercontent.com'] };
  const original = defaultAdminSettings(config);
  const names = new Set(['job_start', 'file_import']);
  assert.equal(validateAdminSettings(original, names).limits.maxJobs, 4);
  assert.throws(() => validateAdminSettings({ ...original, limits: { ...original.limits, maxJobs: 99 } }, names));
  assert.throws(() => validateAdminSettings({ ...original, limits: { ...original.limits, traceRetention: undefined } }, names));
  assert.throws(() => validateAdminSettings({ ...original, blockedTools: ['job_wat'] }, names));
  assert.throws(() => validateAdminSettings({ ...original, downloadOrigins: ['http://unsafe.example'] }, names));
  assert.throws(() => validateAdminSettings({ ...original, downloadOrigins: ['https://safe.example/path'] }, names));
});

test('file manager performs bounded CRUD, upload, and rejects traversal and symlinks', async t => {
  const config = await fixture(t);
  const files = new AdminFiles(config.workspace);
  await mkdir(path.join(config.workspace, 'demo'));
  await files.save('demo/notes.txt', 'Hello 世界');
  assert.equal((await files.text('demo/notes.txt')).content, 'Hello 世界');
  assert.equal((await files.list('demo')).entries[0].name, 'notes.txt');
  await files.move('demo/notes.txt', 'demo/renamed.txt');
  assert.equal((await files.text('demo/renamed.txt')).content, 'Hello 世界');
  assert.equal((await files.upload('demo/binary.bin', Readable.from([Buffer.from([0,255,128])]))).bytes, 3);
  await assert.rejects(files.text('demo/binary.bin'), /Binary|UTF-8/);
  await assert.rejects(files.upload('demo/binary.bin', Readable.from(['overwrite'])), /already exists/);
  await assert.rejects(files.save('../escape.txt', 'danger'));
  await assert.rejects(files.list('/tmp'));
  await assert.rejects(files.remove('.'));
  await symlink(config.root, path.join(config.workspace, 'demo', 'external'));
  await assert.rejects(files.list('demo/external'));
  await assert.rejects(files.text('demo/external/state.json'));
  await assert.rejects(files.remove('demo'), /not empty|ENOTEMPTY/i);
  await files.remove('demo/renamed.txt');
  assert.equal((await files.list('demo')).entries.length, 2);
  await writeFile(path.join(config.workspace, 'demo', 'empty.txt'), '');
  assert.equal((await files.text('demo/empty.txt')).content, '');
});

test('admin API requires login, CSRF, and enforces persisted MCP permissions', async t => {
  const config = await fixture(t);
  const app = await createApp(config), request = requestApp(app);
  assert.equal((await request('/admin/')).status, 200);
  assert.equal((await request('/admin/app.css')).status, 200);
  assert.equal((await request('/admin/api/settings')).status, 401);
  assert.equal((await request('/admin/api/session')).json().authenticated, false);
  assert.equal((await request('/admin/api/login', { method: 'POST', body: '{"password":"wrong"}' })).status, 401);
  const login = await request('/admin/api/login', { method: 'POST', body: '{"password":"admin-secret"}' });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Secure/);
  const headers = { Cookie: cookie };
  const session = (await request('/admin/api/session', { headers })).json();
  assert.equal(session.authenticated, true);
  assert.ok(session.csrf);
  assert.equal((await request('/admin/api/settings', { headers })).status, 200);
  const prior = (await request('/admin/api/settings', { headers })).json().settings;
  const updated = { ...prior, permissions: { ...prior.permissions, fileTransfer: false },
    limits: { ...prior.limits, maxJobs: 2, callsPerMinute: 100 }, blockedTools: ['job_start'] };
  assert.equal((await request('/admin/api/settings', { method:'PUT', headers, body:JSON.stringify(updated) })).status, 403);
  const authorized = { ...headers, 'X-CSRF-Token': session.csrf };
  assert.equal((await request('/admin/api/settings', { method:'PUT', headers:authorized, body:JSON.stringify(updated) })).status, 200);
  assert.equal(app.jobs.maxJobs, 2);
  assert.equal(app.workspaceBatches.config.maxJobs, 2);
  const rawSettings = JSON.parse(await readFile(path.join(config.dataRoot, 'admin-settings.json'), 'utf8'));
  assert.equal(rawSettings.settings.permissions.fileTransfer, false);
  const mcp = await request('/mcp', { method:'POST',
    headers: { Authorization: 'Bearer test-bearer', 'Content-Type':'application/json' },
    body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'tools/list', params:{} }) });
  assert.equal(mcp.status, 200);
  assert.ok(!mcp.json().result.tools.some(x => x.name === 'file_import' || x.name === 'job_start'));
  const denied = await request('/mcp', { method:'POST',
    headers: { Authorization:'Bearer test-bearer', 'Content-Type':'application/json' },
    body: JSON.stringify({ jsonrpc:'2.0', id:2, method:'tools/call', params:{name:'file_import',arguments:{}} }) });
  assert.equal(denied.json().result.isError, true);
  assert.match(denied.text(), /disabled by the administrator/);
  const activity = await request('/admin/api/activity', {headers});
  assert.ok(activity.json().calls.some(x => x.tool === 'file_import' && x.status === 'error'));
  const overview = await request('/admin/api/overview', {headers});
  assert.ok(overview.json().system.memory_total > 0);
  assert.ok(overview.json().calls.total >= 1);
  const restarted = await createApp(config);
  assert.equal(restarted.admin.settings.permissions.fileTransfer, false);
  assert.equal(restarted.jobs.maxJobs, 2);
  assert.equal(restarted.files.maxFileBytes, 512 * 1024 * 1024);
  assert.equal((await request('/admin/api/logout', {method:'POST',headers:authorized})).status, 200);
  assert.equal((await request('/admin/api/settings',{headers})).status, 401);
});

test('admin file APIs prohibit unauthenticated edits and enforce read-only mode', async t => {
  const config = await fixture(t), app = await createApp(config), request = requestApp(app);
  await writeFile(path.join(config.workspace, 'notes.md'), 'original');
  assert.equal((await request('/admin/api/files?path=.')).status, 401);
  const login = await request('/admin/api/login', { method: 'POST', body:'{"password":"admin-secret"}' });
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0] };
  const csrf = (await request('/admin/api/session', {headers})).json().csrf;
  const auth = {...headers, 'X-CSRF-Token':csrf};
  assert.equal((await request('/admin/api/files?path=.',{headers})).json().entries[0].name, 'notes.md');
  assert.equal((await request('/admin/api/files/text?path=notes.md',{headers})).json().content, 'original');
  assert.equal((await request('/admin/api/files/save',{method:'POST',headers,body:JSON.stringify({path:'notes.md',content:'bad'})})).status,403);
  const cfg = (await request('/admin/api/settings',{headers})).json().settings;
  cfg.permissions.fileManagerWrite = false;
  assert.equal((await request('/admin/api/settings',{method:'PUT',headers:auth,body:JSON.stringify(cfg)})).status, 200);
  assert.equal((await request('/admin/api/files/save',{method:'POST',headers:auth,body:JSON.stringify({path:'notes.md',content:'bad'})})).status,403);
  assert.equal(await readFile(path.join(config.workspace, 'notes.md'),'utf8'),'original');
  cfg.permissions.fileManagerWrite = true;
  await request('/admin/api/settings',{method:'PUT',headers:auth,body:JSON.stringify(cfg)});
  assert.equal((await request('/admin/api/files/save',{method:'POST',headers:auth,body:JSON.stringify({path:'notes.md',content:'updated'})})).status,200);
  assert.equal(await readFile(path.join(config.workspace, 'notes.md'),'utf8'),'updated');
});

test('public bearer-only deployment does not accidentally expose admin UI',async t=>{
  const config=await fixture(t);delete config.password;
  const app=await createApp(config),request=requestApp(app);
  assert.equal((await request('/admin/')).status,404);
  assert.equal((await request('/health')).status,200);
});


test('new OAuth settings migrate existing settings, validate ranges and update admin cookie lifetime', async t => {
  const config = await fixture(t);
  const names = new Set(['job_start', 'file_import']);
  const defaults = defaultAdminSettings(config);
  const legacy = { ...defaults };
  delete legacy.oauth;
  delete legacy.security;
  assert.equal(validateAdminSettings(legacy, names).oauth.accessTokenMinutes, 60);
  assert.equal(validateAdminSettings(legacy, names).security.adminSessionMinutes, 480);
  assert.throws(() => validateAdminSettings({ ...defaults, oauth: { ...defaults.oauth, accessTokenMinutes: 0 } }, names));
  assert.throws(() => validateAdminSettings({ ...defaults, oauth: { ...defaults.oauth, authorizationCodeSeconds: 20 } }, names));
  assert.throws(() => validateAdminSettings({ ...defaults, oauth: { ...defaults.oauth, envBearerEnabled: 'false' } }, names));
  assert.throws(() => validateAdminSettings({ ...defaults, oauth: { ...defaults.oauth, extraSecret: 'no' } }, names));
  assert.throws(() => validateAdminSettings({ ...defaults, security: { adminSessionMinutes: 1 } }, names));

  const app = await createApp(config), request = requestApp(app);
  const login = await request('/admin/api/login', { method: 'POST', body: JSON.stringify({ password: config.password }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const csrf = (await request('/admin/api/session', { headers: { Cookie: cookie } })).json().csrf;
  const headers = { Cookie: cookie, 'X-CSRF-Token': csrf };
  const existing = (await request('/admin/api/settings', { headers })).json().settings;
  const revised = { ...existing,
    oauth: { ...existing.oauth, accessTokenMinutes: 120, authorizationCodeSeconds: 90,
      consentFormMinutes: 10, envBearerEnabled: false },
    security: { adminSessionMinutes: 45 } };
  assert.equal((await request('/admin/api/settings', { method: 'PUT', headers, body: JSON.stringify(revised) })).status, 200);
  assert.equal(app.oauth.policy.accessTokenMinutes, 120);
  assert.equal((await request('/mcp', { method: 'POST', headers: {
    Authorization: 'Bearer '+config.bearerToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'ping' }) })).status, 401);
  const nextLogin = await request('/admin/api/login', { method: 'POST', body: JSON.stringify({ password: config.password }) });
  assert.match(nextLogin.headers.get('set-cookie'), /Max-Age=2700/);
  const saved = JSON.parse(await readFile(path.join(config.dataRoot, 'admin-settings.json'), 'utf8'));
  assert.equal(saved.settings.oauth.accessTokenMinutes, 120);
  assert.equal(saved.settings.security.adminSessionMinutes, 45);
  const afterRestart = await createApp(config);
  assert.equal(afterRestart.oauth.policy.accessTokenMinutes, 120);
  assert.equal(afterRestart.admin.settings.security.adminSessionMinutes, 45);
});

test('managed bearer rotation is one-time, password-and-CSRF protected, hashed at rest, revocable and restart-safe', async t => {
  const config = await fixture(t);
  const app = await createApp(config), request = requestApp(app);
  const login = await request('/admin/api/login', { method:'POST', body:JSON.stringify({ password:config.password }) });
  const Cookie = login.headers.get('set-cookie').split(';')[0];
  const csrf = (await request('/admin/api/session', { headers:{Cookie} })).json().csrf;
  const headers = {Cookie, 'X-CSRF-Token':csrf};
  const before = await request('/admin/api/oauth/status', { headers });
  assert.equal(before.json().managedBearer.configured, false);
  assert.equal((await request('/admin/api/oauth/bearer/rotate', {
    method:'POST', headers:{Cookie}, body:JSON.stringify({password:config.password,days:90}) })).status,403);
  assert.equal((await request('/admin/api/oauth/bearer/rotate', {
    method:'POST', headers, body:JSON.stringify({password:'incorrect',days:90}) })).status,403);
  assert.equal((await request('/admin/api/oauth/bearer/rotate', {
    method:'POST', headers, body:JSON.stringify({password:config.password,days:0}) })).status,400);
  const minted = (await request('/admin/api/oauth/bearer/rotate', {
    method:'POST', headers, body:JSON.stringify({password:config.password,days:90}) })).json().access_token;
  assert.match(minted,/^[A-Za-z0-9_-]{43}$/);
  assert.equal((await request('/admin/api/oauth/status',{headers})).text().includes(minted), false);
  const saved = await readFile(path.join(config.dataRoot,'oauth-managed-bearer.json'),'utf8');
  assert.equal(saved.includes(minted),false);
  assert.match(saved,/"hash"/);
  const mcp = (bearer, caller=request) => caller('/mcp',{method:'POST',
    headers:{Authorization:'Bearer '+bearer,'Content-Type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'ping'})});
  assert.equal((await mcp(minted)).status,200);
  const rotated = (await request('/admin/api/oauth/bearer/rotate', {
    method:'POST', headers, body:JSON.stringify({password:config.password,days:90}) })).json().access_token;
  assert.notEqual(minted,rotated);
  assert.equal((await mcp(minted)).status,401);
  assert.equal((await mcp(rotated)).status,200);
  const restarted = await createApp(config);
  assert.equal((await mcp(rotated,requestApp(restarted))).status,200);
  assert.equal((await request('/admin/api/oauth/bearer/revoke', {
    method:'POST',headers,body:JSON.stringify({password:config.password})})).status,200);
  assert.equal((await mcp(rotated)).status,401);
  assert.equal((await mcp(config.bearerToken)).status,200);
  assert.equal((await request('/admin/api/oauth/status',{headers})).json().managedBearer.configured,false);
});

test('OAuth expiry policy and hashed token persistence survive restarts and revocation',async t=>{
  const config={...(await fixture(t)),clientRedirectOrigins:['https://client.example']};
  const app=await createApp(config),request=requestApp(app);
  const login=await request('/admin/api/login',{method:'POST',body:JSON.stringify({password:config.password})});
  const Cookie=login.headers.get('set-cookie').split(';')[0];
  const csrf=(await request('/admin/api/session',{headers:{Cookie}})).json().csrf;
  const headers={Cookie,'X-CSRF-Token':csrf};
  const settings=(await request('/admin/api/settings',{headers})).json().settings;
  settings.oauth.persistAccessTokens=true;
  settings.oauth.accessTokenMinutes=1440;
  settings.oauth.maxClients=2;
  assert.equal((await request('/admin/api/settings',{method:'PUT',headers,body:JSON.stringify(settings)})).status,200);
  const redirect='https://client.example/callback';
  const registered=await request('/oauth/register',{method:'POST',body:JSON.stringify({redirect_uris:[redirect],client_name:'Test Client'})});
  assert.equal(registered.status,201);
  const clientId=registered.json().client_id;
  const verifier='z'.repeat(43);
  const challenge=createHash('sha256').update(verifier).digest('base64url');
  const params=new URLSearchParams({client_id:clientId,redirect_uri:redirect,response_type:'code',
    code_challenge_method:'S256',code_challenge:challenge});
  const page=await request('/oauth/authorize?'+params.toString());
  assert.equal(page.status,200);
  const nonce=page.text().match(/name="form" value="([^"]+)"/)[1];
  const confirmed=await request('/oauth/authorize',{method:'POST',
    body:new URLSearchParams({form:nonce,password:config.password}).toString()});
  assert.equal(confirmed.status,302);
  const code=new URL(confirmed.headers.get('location')).searchParams.get('code');
  const exchange=await request('/oauth/token',{method:'POST',body:new URLSearchParams({
    grant_type:'authorization_code',client_id:clientId,redirect_uri:redirect,
    code,code_verifier:verifier}).toString()});
  assert.equal(exchange.status,200);
  const token=exchange.json().access_token;
  assert.equal(exchange.json().expires_in,86400);
  const persisted=await readFile(path.join(config.dataRoot,'oauth-access-tokens.json'),'utf8');
  assert.equal(persisted.includes(token),false);
  const mcp=(caller)=>caller('/mcp',{method:'POST',headers:{Authorization:'Bearer '+token,
    'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'ping'})});
  assert.equal((await mcp(request)).status,200);
  const restarted=await createApp(config);
  const newerRequest=requestApp(restarted);
  assert.equal((await mcp(newerRequest)).status,200);
  const freshLogin=await newerRequest('/admin/api/login',{method:'POST',body:JSON.stringify({password:config.password})});
  const freshCookie=freshLogin.headers.get('set-cookie').split(';')[0];
  const freshCsrf=(await newerRequest('/admin/api/session',{headers:{Cookie:freshCookie}})).json().csrf;
  const freshHeaders={Cookie:freshCookie,'X-CSRF-Token':freshCsrf};
  assert.equal((await newerRequest('/admin/api/oauth/status',{headers:freshHeaders})).json().activeTokens,1);
  assert.equal((await newerRequest('/admin/api/oauth/clients/revoke',{method:'POST',headers:freshHeaders,
    body:JSON.stringify({client_id:clientId})})).status,200);
  assert.equal((await mcp(newerRequest)).status,401);
  const lastRestart=await createApp(config);
  assert.equal((await mcp(requestApp(lastRestart))).status,401);
  const noClients=(await newerRequest('/admin/api/oauth/status',{headers:freshHeaders})).json();
  assert.equal(noClients.registeredClients,0);
  const changed=(await newerRequest('/admin/api/settings',{headers:freshHeaders})).json().settings;
  changed.oauth.allowDynamicRegistration=false;
  assert.equal((await newerRequest('/admin/api/settings',{method:'PUT',headers:freshHeaders,
    body:JSON.stringify(changed)})).status,200);
  assert.notEqual((await newerRequest('/oauth/register',{method:'POST',body:JSON.stringify({redirect_uris:[redirect]})})).status,201);
});
