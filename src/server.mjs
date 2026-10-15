import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createReadStream } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { clarifyProcessResult } from './process-status.mjs';
import { validateExecutionEnv } from './environment.mjs';
import { Traces, tracePoint } from './trace.mjs';
import { AdminConsole } from './admin.mjs';
import { toolResult } from './common.mjs';
import { Files, fileTools } from './files.mjs';
import { Jobs, jobTools, compactJob } from './jobs.mjs';
import { OAuth } from './oauth.mjs';
import { Workspace, workspaceTools } from './workspace.mjs';
import { ManagedUpstream } from './managed-upstream.mjs';
import { CodeTools, codeTools } from './code-tools.mjs';
import { Review, reviewTool } from './review.mjs';
import { denialReason, PROFILES } from './policy.mjs';
import { developmentGuide, guideTool, jobGuidance, serverInstructions } from './guidance.mjs';

const versions = ['2025-03-26', '2025-06-18', '2025-11-25'];

export async function readBody(req, limit = 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function json(res, status, value) {
  const encoded=JSON.stringify(value);
  if(res._mcpPerf){
    res._mcpPerf.response_bytes=Buffer.byteLength(encoded);
    // The response JSON was already serialized for the client. No second
    // stringify, copy, or body retention unless sensitive capture is enabled.
    if(res._mcpPerf.capture_id)res._mcpPerf.response_body=encoded;
  }
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(encoded);
}

export async function createApp(config) {
  await mkdir(config.workspace, { recursive: true, mode: 0o700 });
  const workspace = await realpath(config.workspace);
  await mkdir(config.dataRoot, { recursive: true, mode: 0o700 });
  const dataRoot = await realpath(config.dataRoot);
  const traces = new Traces(dataRoot);
  await traces.init();
  const files = new Files({ ...config, workspace, dataRoot });
  const jobs = new Jobs({ ...config, workspace, dataRoot });
  await files.init();
  await jobs.init();
  const code = new CodeTools({...config,workspace,dataRoot});
  const review = new Review({...config,workspace,dataRoot});
  const workspaceBatches = new Workspace({ ...config, workspace, dataRoot }, jobs);
  await workspaceBatches.init();
  const oauth = new OAuth({ ...config, dataRoot });
  await oauth.init();
  const upstream = config.upstreamArgv ? new ManagedUpstream(config.upstreamArgv, { ...config, dataRoot, workspace }) : null;
  if (upstream) await upstream.init();
  const localTools = [guideTool, ...fileTools, ...codeTools, ...jobTools, ...workspaceTools, reviewTool];
  const localNames = new Set(localTools.map(tool => tool.name));
  const upstreamTools = [...(upstream?.tools || [])].filter(tool=>!localNames.has(tool.name));
  const tools = [...localTools, ...upstreamTools];
  const upstreamNames = new Set(upstreamTools.map(tool => tool.name));
  const admin = new AdminConsole({ config: { ...config, workspace, dataRoot }, traces, files, jobs, workspaceBatches, oauth, tools, upstreamNames });
  await admin.init();
  await traces.prune();
  if(upstream)upstream.onTools=items=>{
    items=items.filter(t=>!localNames.has(t.name));
    upstreamTools.splice(0,upstreamTools.length,...items);
    upstreamNames.clear();items.forEach(t=>upstreamNames.add(t.name));
    tools.splice(0,tools.length,...localTools,...items);admin.names=new Set(tools.map(t=>t.name));
  };
  const catalog=()=>{
    const visible=admin.visibleTools();
    return {version:'0.3.7',profile:admin.settings.toolProfile,
      sha256:createHash('sha256').update(JSON.stringify(visible)).digest('hex'),
      visible_tools:visible.map(t=>t.name),registered_count:tools.length,visible_count:visible.length,
      upstream:upstream?.status() || {configured:false,connected:false},
      tools:tools.map(t=>({name:t.name,origin:localNames.has(t.name)?'core':'desktop_commander',enabled:admin.allowed(t.name),reason:denialReason(admin.settings,t.name,{},upstreamNames.has(t.name))})),
      client_refresh_required:'Server discovery is not the ChatGPT published action snapshot. After upgrade/profile changes, refresh, review and publish app actions.'};
  };
  admin.catalog=catalog;
  const upstreamAllowed=()=>admin.settings.toolProfile!=='core' && admin.settings.permissions.desktopCommander && admin.settings.permissions.filesystemRead;
  const capabilities = { tools: {}, resources: {} };
  if (upstream?.info.capabilities.prompts) capabilities.prompts = {};

  async function dispatch(method, params = {}) {
    if (method === 'tools/call') return traces.call(localNames.has(params.name) || upstreamNames.has(params.name) ? params.name : 'unknown_tool', upstreamNames.has(params.name) ? 'desktop_commander' : 'gateway', async()=>{
      tracePoint('dispatch.begin', {argument_fields:Object.keys(params.arguments||{}).length});
      return await dispatchTool(params);
    });
    if (method === 'initialize') return { protocolVersion: versions.includes(params.protocolVersion) ? params.protocolVersion : '2025-03-26', capabilities, serverInfo: { name: 'chatgpt-dev-mcp', version: '0.3.7' }, instructions: serverInstructions };
    if (method === 'ping') return {};
    if (method === 'tools/list') return { tools: admin.visibleTools(), _meta: {'starix/catalog_sha256':catalog().sha256} };
    if (method === 'resources/list') {
      const own = admin.allowed('file_export') ? await files.listResources() : { resources: [] };
      if (upstreamAllowed() && upstream?.info.capabilities.resources) own.resources.push(...await upstream.listAll(method, 'resources'));
      return own;
    }
    if (method === 'resources/read') {
      if (params.uri?.startsWith('artifact:') && admin.allowed('file_export')) return files.readResource(params.uri);
      if (upstreamAllowed() && upstream?.info.capabilities.resources && !params.uri?.startsWith('artifact:')) return upstream.request(method, params);
      throw Object.assign(new Error('Unknown or disabled resource'), { rpcCode: -32002 });
    }
    if (method === 'resources/templates/list') return { resourceTemplates: upstreamAllowed() && upstream?.info.capabilities.resources ? await upstream.listAll(method, 'resourceTemplates') : [] };
    if (method.startsWith('prompts/') && upstreamAllowed() && upstream?.info.capabilities.prompts) return upstream.request(method, params);
    throw Object.assign(new Error('Method not found'), { rpcCode: -32601 });
  }

  async function dispatchTool(params) {
      let args = params.arguments || {};
      try {
        tracePoint('policy.begin');
        args = admin.enforce(params.name, args);
        tracePoint('policy.end');
        switch (params.name) {
          case 'dev_get_guide': {
            const guide = developmentGuide({ workspace, upstreamTools:upstreamTools.filter(t=>admin.allowed(t.name)), executionEnv: config.executionEnv, containerBuildSocket: config.containerBuildSocket, catalog:catalog() });
            if (args.include_diagnostics || args.trace_id) {
              guide.diagnostics = await traces.read({ trace_id: args.trace_id, limit: args.limit });
              const allJobs = await jobs.list();
              const executions = (await workspaceBatches.list()).executions;
              guide.diagnostics.jobs = allJobs.filter(job => !args.trace_id || job.trace_id === args.trace_id).map(({ id, trace_id, batch_execution_id, batch_step_id, job_kind, status, exit_code, created_at, finished_at }) => ({ id, trace_id, batch_execution_id, batch_step_id, kind: job_kind || 'command', status, exit_code, created_at, finished_at })).slice(0, 50);
              guide.diagnostics.executions = executions.filter(batch => !args.trace_id || batch.trace_id === args.trace_id).slice(0, 50);
            }
            return toolResult(guide);
          }
          case 'file_import': return toolResult({ ...(await files.importFile(args)), next_step: 'The original bytes are now on the server. For ZIP projects call file_unpack with this path; otherwise use server tools to inspect it. This path is relative to workspace_root.' });
          case 'file_unpack': return toolResult({ ...(await files.unpack(args)), next_step: 'Use this path as the project root and job_start.cwd. Inspect project instructions and files before editing or running tests.' });
          case 'file_export': return await files.exportFile(args);
          case 'fs_list': return toolResult(await code.list(args));
          case 'fs_read': return toolResult(await code.read(args));
          case 'fs_search': return toolResult(await code.search(args));
          case 'workspace_review': return toolResult(await review.read(args));
          case 'job_start':
            if (args.tty === true && admin.settings.toolProfile === 'core')
              throw new Error('PTY sessions require interactive or legacy tool profile');
            return toolResult(jobGuidance(compactJob(await jobs.start({ argv: args.argv, command:args.command, request_id:args.request_id, tty:args.tty, wait_ms:args.wait_ms, max_bytes:args.max_bytes, cwd: args.cwd, env: args.env, timeout_seconds: args.timeout_seconds }))));
          case 'job_read': return toolResult(jobGuidance(compactJob(await jobs.read(args),args.include_command===true)));
          case 'job_input': return toolResult(jobGuidance(compactJob(await jobs.input(args))));
          case 'job_list': return toolResult(await jobs.page(args));
          case 'job_cancel': return toolResult(compactJob(await jobs.cancel(args)));
          case 'workspace_execute': return toolResult(await workspaceBatches.execute(args));
          case 'workspace_read': return toolResult(await workspaceBatches.read(args));
          case 'workspace_list': return toolResult(await workspaceBatches.list());
          case 'workspace_cancel': return toolResult(await workspaceBatches.cancel(args));
          default:
            if (upstreamNames.has(params.name)) return clarifyProcessResult(params.name, args, await upstream.request('tools/call', params), upstream);
            throw new Error('Unknown tool');
        }
      } catch (error) {
        const hint = /disabled|profile/.test(error.message)?'Review the server tool profile/permissions; do not retry the same blocked action.':
          /sha256|context|changed/.test(error.message)?'Reread the affected code with fs_read, then prepare a new request_id.':
          /request_id|reservation/.test(error.message)?'Inspect existing jobs/batches before any retry; do not create a duplicate operation.':
          'Check arguments, path and permissions. A tool error is not successful completion.';
        return toolResult({error:{code:error.code || 'TOOL_ERROR',message:error.message},next_step:hint},{isError:true});
      } finally {
        tracePoint('dispatch.end');
      }
    }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const url = new URL(req.url, config.publicBaseURL || 'http://localhost');
      // Disabled hot path: one boolean check, NO performance clock, listeners,
      // body copies, JSON serialization, allocations, hashing or disk I/O.
      if(admin.performance.enabled() && url.pathname==='/mcp'){
        const meta={started:performance.now(),method:'unparsed',request_bytes:0,
          read_body_ms:0,parse_ms:0,dispatch_ms:0,response_bytes:0};
        res._mcpPerf=meta;
        let recorded=false;
        const record=()=>{
          if(recorded)return;
          recorded=true;
          admin.performance.capture({...meta,status:res.statusCode,
            duration_ms:performance.now()-meta.started});
        };
        res.once('finish',record);
        res.once('close',()=>{if(!res.writableFinished)record();});
      }
      // Browser form submissions can carry an opaque Origin ("null"), including
      // under a no-referrer policy. Authorization forms remain protected by a
      // single-use nonce, password, registered redirect and PKCE. Keep the MCP
      // transport's DNS-rebinding protection and other endpoints strict.
      const opaqueAuthorizationOrigin = req.headers.origin === 'null' && url.pathname === '/oauth/authorize' && ['GET', 'POST'].includes(req.method);
      if (req.headers.origin && !config.httpOrigins?.includes(req.headers.origin) && !opaqueAuthorizationOrigin) { json(res, 403, { error: 'Origin not allowed' }); return; }
      if (url.pathname === '/health' && req.method === 'GET') { json(res, 200, { ok: true, version:'0.3.7' }); return; }
      if (await admin.handle(req, res, url, readBody, json)) return;
      if (await oauth.handle(req, res, url, readBody, json)) return;
      if (url.pathname.startsWith('/artifacts/') && (req.method === 'GET' || req.method === 'HEAD')) {
        if (!admin.allowed('file_export')) { json(res, 403, { error: 'Artifact downloads are disabled' }); return; }
        let artifact;
        try { artifact = await files.downloadArtifact(url.pathname.slice('/artifacts/'.length), url.searchParams.get('expires'), url.searchParams.get('token')); }
        catch { json(res, 403, { error: 'Invalid or expired artifact link' }); return; }
        res.writeHead(200, { 'Content-Type': artifact.mimeType, 'Content-Length': artifact.bytes, 'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(artifact.name)}`, 'Cache-Control': 'private, no-store' });
        if (req.method === 'HEAD') res.end();
        else await pipeline(createReadStream(artifact.filename), res);
        return;
      }
      if (url.pathname !== '/mcp') { json(res, 404, { error: 'Not found' }); return; }
      if (!oauth.authorized(req)) { oauth.challenge(res); return; }
      // Stateless Streamable HTTP: JSON response to each POST; no unsolicited SSE.
      if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return; }
      // Only authenticated MCP POST requests are eligible for raw payload
      // capture. HTTP auth/Cookie headers and Admin endpoints never qualify.
      if(res._mcpPerf && admin.performance.contentEnabled())
        res._mcpPerf.capture_id=randomUUID();
      if (!req.headers['content-type']?.includes('application/json')) { json(res, 415, { error: 'Expected application/json' }); return; }
      if (req.headers['mcp-protocol-version'] && !versions.includes(req.headers['mcp-protocol-version'])) { json(res, 400, { error: 'Unsupported MCP protocol version' }); return; }
      let message;
      try {
        const readStarted=performance.now();
        const raw=await readBody(req);
        if(res._mcpPerf){
          if(res._mcpPerf.capture_id)res._mcpPerf.request_body=raw;
          res._mcpPerf.read_body_ms=performance.now()-readStarted;
          res._mcpPerf.request_bytes=Buffer.byteLength(raw);
        }
        const parseStarted=performance.now();
        message=JSON.parse(raw);
        if(res._mcpPerf)res._mcpPerf.parse_ms=performance.now()-parseStarted;
      } catch {
        json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error or request too large' } }); return;
      }
      if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || (message.params !== undefined && (!message.params || typeof message.params !== 'object' || Array.isArray(message.params)))) {
        json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }); return;
      }
      if(res._mcpPerf){
        res._mcpPerf.method=message.method;
        if(message.method==='tools/call')res._mcpPerf.tool=(localNames.has(message.params?.name)||upstreamNames.has(message.params?.name))?message.params.name:'unknown_tool';
      }
      if (message.id === undefined) { res.writeHead(202); res.end(); return; }
      const dispatchStarted=performance.now();
      try {
        const result=await dispatch(message.method,message.params);
        if(res._mcpPerf){
          res._mcpPerf.dispatch_ms=performance.now()-dispatchStarted;
          res._mcpPerf.trace_id=result?._meta?.['dev/trace_id'];
          if(res._mcpPerf.trace_id)res._mcpPerf.stages=traces.takeDebug(res._mcpPerf.trace_id);
          // Tools encode their logical errors in isError while HTTP remains 200.
          res._mcpPerf.tool_error=result?.isError===true ? 1 : 0;
        }
        json(res, 200, { jsonrpc: '2.0', id: message.id, result });
      } catch (error) {
        if(res._mcpPerf){
          res._mcpPerf.dispatch_ms=performance.now()-dispatchStarted;
          res._mcpPerf.rpc_error=1;
        }
        json(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: error.rpcCode || -32603, message: error.message } });
      }
    } catch (error) {
      if (!res.headersSent) json(res, 400, { error: error.message });
      else res.destroy();
    }
  });
  server.on('close', () => upstream?.close());
  return { server, files, jobs, oauth, tools, workspaceBatches, admin, catalog, code, review, upstream };
}

export function envConfig(env = process.env) {
  const split = value => (value || '').split(',').map(value => value.trim()).filter(Boolean);
  const publicBaseURL = (env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (publicBaseURL) {
    const url = new URL(publicBaseURL);
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('PUBLIC_BASE_URL must be an HTTPS origin without a path');
  }
  if (!env.MCP_BEARER_TOKEN && !env.MCP_OWNER_PASSWORD) throw new Error('Set MCP_OWNER_PASSWORD for ChatGPT OAuth or MCP_BEARER_TOKEN for local/API clients');
  if (env.MCP_OWNER_PASSWORD && !publicBaseURL) throw new Error('OAuth requires PUBLIC_BASE_URL');
  const positive = (name, fallback) => {
    const value = Number(env[name] || fallback);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
    return value;
  };
  if(env.MCP_TOOL_PROFILE && !PROFILES.includes(env.MCP_TOOL_PROFILE))throw new Error('MCP_TOOL_PROFILE must be core, interactive or legacy');
  const workspace = path.resolve(env.WORKSPACE_ROOT || 'workspace');
  if (Boolean(env.EXECUTION_UID) !== Boolean(env.EXECUTION_GID)) throw new Error('Set EXECUTION_UID and EXECUTION_GID together');
  return {
    workspace, dataRoot: path.resolve(env.MCP_DATA_ROOT || '.chatgpt-mcp'), publicBaseURL,
    password: env.MCP_OWNER_PASSWORD, adminPassword: env.MCP_ADMIN_PASSWORD, bearerToken: env.MCP_BEARER_TOKEN,
    clientRedirectOrigins: split(env.OAUTH_REDIRECT_ORIGINS),
    httpOrigins: [...split(env.HTTP_ALLOWED_ORIGINS), ...(publicBaseURL ? [publicBaseURL] : [])],
    allowedOrigins: split(env.FILE_DOWNLOAD_ORIGINS),
    maxFileBytes: positive('MAX_FILE_BYTES', 512 * 1024 * 1024),
    maxResourceBytes: positive('MAX_RESOURCE_BYTES', 8 * 1024 * 1024),
    maxJobs: positive('MAX_JOBS', 4),
    executionUid: env.EXECUTION_UID ? positive('EXECUTION_UID', 1) : undefined,
    executionGid: env.EXECUTION_GID ? positive('EXECUTION_GID', 1) : undefined,
    executionHome: env.EXECUTION_HOME,
    executionEnv: validateExecutionEnv(env.EXECUTION_ENV ? JSON.parse(env.EXECUTION_ENV) : {}),
    containerBuildSocket: env.CONTAINER_BUILD_SOCKET,
    toolProfile: env.MCP_TOOL_PROFILE || 'core',
    upstreamArgv: env.DESKTOP_COMMANDER_COMMAND ? JSON.parse(env.DESKTOP_COMMANDER_COMMAND) : null,
    host: env.HOST || '127.0.0.1', port: positive('PORT', 8787)
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = envConfig();
    const { server } = await createApp(config);
    server.on('error', error => { console.error(`HTTP listen failed: ${error.message}`); process.exit(1); });
    server.listen(config.port, config.host, () => console.error(`chatgpt-dev-mcp listening on http://${config.host}:${config.port}/mcp`));
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
