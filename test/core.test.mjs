import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { Readable, Writable as importWritable, PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { Files, publicIP, validateDownloadURL } from '../src/files.mjs';
import { Jobs, processIdentity } from '../src/jobs.mjs';
import { createApp } from '../src/server.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chatgpt-mcp-test-'));
  const workspace = path.join(root, 'workspace');
  const dataRoot = path.join(root, 'state');
  await mkdir(workspace);
  await mkdir(dataRoot);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, workspace, dataRoot, publicBaseURL: 'https://dev.example', bearerToken: 'test-token', httpOrigins: [] };
}

// Exercise the exact HTTP request handler without binding a network socket.
// This sandbox denies listen(); a native Node test-runner crash masks that EPERM.
function requestApp(app) {
  return async function fetch(input, options = {}) {
    const url = new URL(input);
    const body = options.body?.toString() || '';
    const req = Readable.from(body ? [Buffer.from(body)] : []);
    req.url = url.pathname + url.search;
    req.method = options.method || 'GET';
    req.headers = Object.fromEntries(Object.entries(options.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
    req.socket = { remoteAddress: '127.0.0.1' };
    return new Promise((resolve, reject) => {
      const headers = new Map();
      const chunks = [];
      let status = 200;
      const res = new (class extends importWritable {})({
        write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); }
      });
      res.headersSent = false;
      res.setHeader = (key, value) => headers.set(key.toLowerCase(), value);
      res.writeHead = (code, values = {}) => {
        status = code;
        res.headersSent = true;
        for (const [key, value] of Object.entries(values)) res.setHeader(key, value);
      };
      res.on('error', reject);
      res.on('finish', () => {
        const bytes = Buffer.concat(chunks);
        resolve({ status, headers: { get: name => headers.get(name.toLowerCase()) || null }, text: async () => bytes.toString(), json: async () => JSON.parse(bytes.toString()) });
      });
      app.server.emit('request', req, res);
    });
  };
}

async function terminal(jobs, id, deadlineMs = 7000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const state = await jobs.status(id);
    if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(state.status)) return state;
    await delay(40);
  }
  throw new Error('Job did not reach a terminal state');
}

test('file import receives exact bytes, computes SHA-256 and preserves file metadata', async t => {
  const config = await fixture(t);
  const bytes = Buffer.from([0, 255, 1, 2, 128, 10]);
  const files = new Files({ ...config, download: async (_url, target) => { await writeFile(target, bytes); return bytes.length; } });
  await files.init();
  const result = await files.importFile({ file: { download_url: 'https://files.example/input', file_id: 'file_test', file_name: '../../payload.bin' } });
  assert.deepEqual(await readFile(path.join(config.workspace, result.path)), bytes);
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.original_name, 'payload.bin');
  assert.equal(result.bytes, bytes.length);
});

test('download guard rejects unapproved origins, credentials, private and mapped addresses', () => {
  const allowed = new Set(['https://files.example']);
  assert.equal(validateDownloadURL('https://files.example/input?token=abc', allowed).hostname, 'files.example');
  for (const url of ['http://files.example/input', 'https://other.example/input', 'https://user@files.example/input']) assert.throws(() => validateDownloadURL(url, allowed));
  for (const ip of [
    '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '192.88.99.1',
    '198.51.100.5', '203.0.113.8',
    '::1', '::ffff:127.0.0.1', 'fc00::1',
    '2001:db8::1', '2001:0DB8::1', '3fff::1'
  ]) assert.equal(publicIP(ip), false, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1']) assert.equal(publicIP(ip), true, ip);
  assert.equal(publicIP('2606:4700:4700::1111'), true);
});

test('HTTPS download wildcards allow Azure accounts and reject lookalike hosts and nonstandard ports', () => {
  const allowed = new Set(['https://files.example', 'https://*.blob.core.windows.net']);
  for (const url of [
    'https://oaisdmntpreastus2.blob.core.windows.net/container/file.zip?signature=test',
    'https://anotheraccount.blob.core.windows.net/container/file.zip',
    'https://AnotherAccount.blob.core.windows.net:443/container/file.zip',
    'https://files.example/file.zip'
  ]) assert.doesNotThrow(() => validateDownloadURL(url, allowed));
  for (const url of [
    'https://blob.core.windows.net/file.zip',
    'https://evilblob.core.windows.net.evil.example/file.zip',
    'https://evilblob.core.windows.net@evil.example/file.zip',
    'https://evilblobcore.windows.net/file.zip',
    'https://account.blob.core.windows.net:8443/file.zip',
    'http://account.blob.core.windows.net/file.zip',
    'https://user@account.blob.core.windows.net/file.zip',
    'https://account.blob.core.windows.net/file.zip#fragment'
  ]) assert.throws(() => validateDownloadURL(url, allowed), undefined, url);
});

test('exports snapshot bytes, enforce signed URLs and serve binary MCP resources', async t => {
  const config = await fixture(t);
  const files = new Files(config);
  await files.init();
  const bytes = Buffer.from('original contents');
  await writeFile(path.join(config.workspace, 'report.txt'), bytes);
  const exported = (await files.exportFile({ path: 'report.txt' })).structuredContent;
  await writeFile(path.join(config.workspace, 'report.txt'), 'changed');
  const url = new URL(exported.download_url);
  const artifact = await files.downloadArtifact(exported.id, url.searchParams.get('expires'), url.searchParams.get('token'));
  assert.deepEqual(await readFile(artifact.filename), bytes);
  await assert.rejects(files.downloadArtifact(exported.id, url.searchParams.get('expires'), 'invalid'));
  await assert.rejects(files.downloadArtifact(exported.id, '1', url.searchParams.get('token')));
  assert.deepEqual(Buffer.from((await files.readResource(exported.resource_uri)).contents[0].blob, 'base64'), bytes);
  await assert.rejects(files.exportFile({ path: '../state' }));
  await symlink(config.dataRoot, path.join(config.workspace, 'escape'));
  await assert.rejects(files.exportFile({ path: 'escape' }));
});

test('directory ZIP round trip excludes secrets; extraction rejects path traversal', async t => {
  const config = await fixture(t);
  const files = new Files(config);
  await files.init();
  await mkdir(path.join(config.workspace, 'project', 'src'), { recursive: true });
  await writeFile(path.join(config.workspace, 'project', 'src', '你好.txt'), 'hello ZIP');
  await writeFile(path.join(config.workspace, 'project', '.env'), 'secret');
  const exported = (await files.exportFile({ path: 'project' })).structuredContent;
  const artifact = await files.artifact(exported.id);
  await writeFile(path.join(config.workspace, 'input.zip'), await readFile(artifact.filename));
  const unpacked = await files.unpack({ path: 'input.zip' });
  assert.equal(unpacked.files, 1);
  assert.equal(await readFile(path.join(config.workspace, unpacked.path, 'src', '你好.txt'), 'utf8'), 'hello ZIP');
  const malicious = path.join(config.workspace, 'bad.zip');
  const python = spawn('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr("../escaped.txt","bad"); z.close()', malicious]);
  assert.equal(await new Promise(resolve => python.once('exit', resolve)), 0);
  await assert.rejects(files.unpack({ path: 'bad.zip' }), /unsafe/);
});

test('durable jobs retain incremental output and exit code across manager recreation', async t => {
  const config = await fixture(t);
  const jobs = new Jobs(config);
  await jobs.init();
  const job = await jobs.start({ argv: [process.execPath, '-e', 'console.log("first"); setTimeout(()=>console.log("second"),300)'] });
  const resumed = new Jobs(config);
  await resumed.init();
  assert.equal((await terminal(resumed, job.id)).status, 'succeeded');
  const first = await resumed.read({ job_id: job.id, max_bytes: 6 });
  assert.equal(first.output, 'first\n');
  assert.equal(first.has_more, true);
  const second = await resumed.read({ job_id: job.id, offset: first.next_offset });
  assert.equal(second.output, 'second\n');
  assert.equal(second.exit_code, 0);
  assert.equal((await resumed.list()).length, 1);
  const failed = await jobs.start({ argv: [process.execPath, '-e', 'process.exit(7)'] });
  assert.equal((await terminal(jobs, failed.id)).exit_code, 7);
  const missing = await jobs.start({ argv: ['/nonexistent/chatgpt-mcp-command'] });
  assert.equal((await terminal(jobs, missing.id)).status, 'failed');
  await assert.rejects(jobs.start({ argv: ['true'], cwd: '..' }));
});

test('job cancellation and timeout terminate process groups', async t => {
  const config = await fixture(t);
  const jobs = new Jobs(config);
  await jobs.init();
  const job = await jobs.start({ argv: [process.execPath, '-e', 'setInterval(()=>console.log("running"),50)'] });
  let state;
  for (let i = 0; i < 100; i++) { state = await jobs.status(job.id); if (state.command_pid) break; await delay(20); }
  assert.ok(state.command_pid);
  await jobs.cancel({ job_id: job.id });
  assert.equal((await terminal(jobs, job.id)).status, 'cancelled');
  for (let i = 0; i < 100 && await processIdentity(state.command_pid); i++) await delay(30);
  assert.equal(await processIdentity(state.command_pid), null);
  const timeoutJob = await jobs.start({ argv: [process.execPath, '-e', 'setInterval(()=>{},100)'], timeout_seconds: 1 });
  const result = await terminal(jobs, timeoutJob.id);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.reason, 'timeout');
  await delay(2200); // Let escalation clean up the dedicated workers before fixture removal.
});

test('HTTP MCP preserves fileParams, requires authentication and supports resource download', async t => {
  const config = await fixture(t);
  const app = await createApp(config);
  t.after(() => app.server.emit('close'));
  const fetch = requestApp(app);
  const base = 'http://localhost';
  const rpc = async (method, params = {}) => {
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    assert.equal(response.status, 200);
    return (await response.json()).result;
  };
  assert.equal((await fetch(`${base}/mcp`, { method: 'POST' })).status, 401);
  assert.equal((await rpc('initialize', { protocolVersion: '2025-03-26' })).protocolVersion, '2025-03-26');
  const tools = (await rpc('tools/list')).tools;
  assert.deepEqual(tools.find(tool => tool.name === 'file_import')._meta, { 'openai/fileParams': ['file'] });
  for (const name of ['workspace_execute', 'workspace_read', 'workspace_list', 'workspace_cancel']) assert.ok(tools.find(tool => tool.name === name));
  const batch = await rpc('tools/call', { name: 'workspace_execute', arguments: { wait_ms: 10000, steps: [{ type: 'write', path: 'batch.txt', content: 'batch through MCP' }] } });
  assert.equal(batch.structuredContent.status, 'succeeded');
  assert.equal(await readFile(path.join(config.workspace, 'batch.txt'), 'utf8'), 'batch through MCP');
  await writeFile(path.join(config.workspace, 'hello.txt'), 'hello');
  const output = await rpc('tools/call', { name: 'file_export', arguments: { path: 'hello.txt' } });
  const remote = new URL(output.structuredContent.download_url);
  const download = await fetch(`${base}${remote.pathname}${remote.search}`);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), 'hello');
  const resource = await rpc('resources/read', { uri: output.structuredContent.resource_uri });
  assert.equal(Buffer.from(resource.contents[0].blob, 'base64').toString(), 'hello');
});

test('OAuth validates PKCE, binds redirects and rejects code reuse', async t => {
  const config = { ...await fixture(t), password: 'owner-password', clientRedirectOrigins: ['https://client.example'] };
  const app = await createApp(config);
  t.after(() => app.server.emit('close'));
  const fetch = requestApp(app);
  const base = 'http://localhost';
  const redirect = 'https://client.example/callback';
  const registration = await fetch(`${base}/oauth/register`, { method: 'POST', body: JSON.stringify({ redirect_uris: [redirect] }) });
  assert.equal(registration.status, 201);
  const client = await registration.json();
  const verifier = 'a'.repeat(43);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const params = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge, state: 'client-state' });
  const page = await fetch(`${base}/oauth/authorize?${params}`, { headers: { Origin: 'null' } });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('referrer-policy'), 'strict-origin');
  assert.equal(page.headers.get('content-security-policy'), "default-src 'none'; form-action 'self' https://client.example; frame-ancestors 'none'");
  const html = await page.text();
  const form = html.match(/name="form" value="([^"]+)"/)[1];
  assert.equal((await fetch(`${base}/oauth/authorize`, { method: 'POST', headers: { Origin: 'null' }, body: new URLSearchParams({ form: 'invalid-nonce', password: config.password }) })).status, 400);
  assert.equal((await fetch(`${base}/oauth/authorize?${params}`, { headers: { Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await fetch(`${base}/oauth/register`, { method: 'POST', headers: { Origin: 'null' }, body: JSON.stringify({ redirect_uris: [redirect] }) })).status, 403);
  const wrongPage = await fetch(`${base}/oauth/authorize?${params}`);
  const wrongForm = (await wrongPage.text()).match(/name="form" value="([^"]+)"/)[1];
  assert.equal((await fetch(`${base}/oauth/authorize`, { method: 'POST', headers: { Origin: 'null' }, body: new URLSearchParams({ form: wrongForm, password: 'wrong-password' }) })).status, 403);
  const approved = await fetch(`${base}/oauth/authorize`, { method: 'POST', headers: { Origin: 'null' }, body: new URLSearchParams({ form, password: config.password }), redirect: 'manual' });
  assert.equal(approved.status, 302);
  const callback = new URL(approved.headers.get('location'));
  assert.equal(callback.searchParams.get('state'), 'client-state');
  const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: redirect, code: callback.searchParams.get('code'), code_verifier: verifier });
  const exchanged = await fetch(`${base}/oauth/token`, { method: 'POST', body });
  assert.equal(exchanged.status, 200);
  const { access_token } = await exchanged.json();
  assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'null', Authorization: `Bearer ${access_token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) })).status, 403);
  assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access_token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) })).status, 200);
  assert.equal((await fetch(`${base}/oauth/token`, { method: 'POST', body })).status, 400);
  assert.equal((await fetch(`${base}/oauth/register`, { method: 'POST', body: JSON.stringify({ redirect_uris: ['https://attacker.example/callback'] }) })).status, 400);
});

test('OAuth client registration survives a restart and still binds the exact redirect', async t => {
  const config = { ...await fixture(t), password: 'owner-password', clientRedirectOrigins: ['https://client.example'] };
  const first = await createApp(config);
  t.after(() => first.server.emit('close'));
  const redirect = 'https://client.example/connector/oauth/test-client';
  const response = await requestApp(first)('http://localhost/oauth/register', { method: 'POST', body: JSON.stringify({ redirect_uris: [redirect] }) });
  assert.equal(response.status, 201);
  const { client_id } = await response.json();
  const restarted = await createApp(config);
  t.after(() => restarted.server.emit('close'));
  const fetch = requestApp(restarted);
  const params = new URLSearchParams({ client_id, redirect_uri: redirect, response_type: 'code', code_challenge_method: 'S256', code_challenge: createHash('sha256').update('b'.repeat(43)).digest('base64url') });
  assert.equal((await fetch(`http://localhost/oauth/authorize?${params}`, { headers: { Origin: 'null' } })).status, 200);
  params.set('redirect_uri', 'https://client.example/other');
  assert.equal((await fetch(`http://localhost/oauth/authorize?${params}`)).status, 400);
  params.set('redirect_uri', redirect);
  params.set('client_id', 'unknown-client');
  assert.equal((await fetch(`http://localhost/oauth/authorize?${params}`)).status, 400);
});

test('Desktop Commander bridge preserves tool metadata and resource results', async t => {
  const config = await fixture(t);
  const upstreamSpawn = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    const lines = createInterface({ input: child.stdin });
    lines.on('line', line => {
      const message = JSON.parse(line);
      if (message.id === undefined) return;
      let result;
      if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1' } };
      if (message.method === 'tools/list') result = { tools: [{ name: 'dc_test', description: 'mock', inputSchema: { type: 'object' }, _meta: { 'openai/fileParams': ['file'] }, annotations: { readOnlyHint: true } }] };
      if (message.method === 'tools/call') result = { content: [{ type: 'resource_link', uri: 'https://example.com/file', name: 'file' }], structuredContent: { ok: true } };
      child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
    });
    child.kill = () => { lines.close(); child.stdin.end(); child.stdout.end(); child.emit('exit', 0); };
    return child;
  };
  const app = await createApp({ ...config, toolProfile:'legacy', upstreamArgv: ['mock-upstream'], upstreamSpawn });
  t.after(() => app.server.emit('close'));
  const fetch = requestApp(app);
  assert.deepEqual(app.tools.find(tool => tool.name === 'dc_test')._meta, { 'openai/fileParams': ['file'] });
  const response = await fetch('http://localhost/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'dc_test' } }) });
  const result = (await response.json()).result;
  assert.equal(result.content[0].type, 'resource_link');
  assert.equal(result.structuredContent.ok, true);
});
