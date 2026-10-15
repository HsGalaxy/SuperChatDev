import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFile, readFile, readdir, statfs } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { atomicJSON, readJSON, requireInteger } from './common.mjs';
import { AdminFiles } from './admin-files.mjs';
import { GitAdmin } from './git-admin.mjs';
import { PerformanceLog, DEFAULT_PERFORMANCE, validatePerformance } from './performance.mjs';
import { PROFILES, denialReason, LEGACY_TOOL_NAMES } from './policy.mjs';

const MiB = 1024 * 1024;
const rootDir = fileURLToPath(new URL('../', import.meta.url));
const permissionKeys = ['fileTransfer', 'jobs', 'workspace', 'desktopCommander', 'containerBuild', 'commandExecution', 'fileManagerWrite', 'filesystemRead', 'filesystemWrite'];
const limitRanges = {
  maxJobs: [1, 32], maxFileMB: [1, 2048], maxResourceMB: [1, 64], maxUploadMB: [1, 512],
  maxJobSeconds: [30, 86400], maxBatchSteps: [1, 32], maxParallelism: [1, 4],
  callsPerMinute: [0, 5000], traceRetention: [100, 20000], maxJobLogMB:[1,256]
};
const oauthRanges = { refreshTokenDays: [1, 90], accessTokenMinutes: [1, 43200], authorizationCodeSeconds: [30, 600],
  consentFormMinutes: [1, 30], maxClients: [1, 1000] };
const oauthBooleans = ['allowDynamicRegistration', 'envBearerEnabled', 'persistAccessTokens', 'refreshTokensEnabled'];
const adminSecurityRanges = { adminSessionMinutes: [5, 10080] };
const defaultOAuth = () => ({ accessTokenMinutes: 60, authorizationCodeSeconds: 60,
  consentFormMinutes: 5, maxClients: 1000, allowDynamicRegistration: true,
  envBearerEnabled: true, persistAccessTokens: false, refreshTokensEnabled: true, refreshTokenDays: 30 });
const defaultSecurity = () => ({ adminSessionMinutes: 480 });
const token = () => randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
const clone = x => JSON.parse(JSON.stringify(x));

export function defaultAdminSettings(config) {
  return {
    permissions: Object.fromEntries(permissionKeys.map(name => [name, true])),
    limits: {
      maxJobs: config.maxJobs ?? 4,
      maxFileMB: Math.max(1, Math.round((config.maxFileBytes ?? 512 * MiB) / MiB)),
      maxResourceMB: Math.max(1, Math.round((config.maxResourceBytes ?? 8 * MiB) / MiB)), maxUploadMB: 32,
      maxJobSeconds: 86400, maxBatchSteps: 32, maxParallelism: 4,
      callsPerMinute: 0, traceRetention: 5000, maxJobLogMB:16
    },
    downloadOrigins: [...(config.allowedOrigins || [])],
    blockedTools: [],
    toolProfile: config.toolProfile || 'core',
    oauth: defaultOAuth(),
    security: defaultSecurity(),
    performance:{...DEFAULT_PERFORMANCE}
  };
}

export function validateAdminSettings(input, toolNames) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(x => !['permissions', 'limits', 'downloadOrigins', 'blockedTools', 'oauth', 'security', 'performance', 'toolProfile'].includes(x))) throw new Error('Invalid settings document');
  const { downloadOrigins, blockedTools } = input;
  const permissions={filesystemRead:true,filesystemWrite:true,...input.permissions};
  const limits={maxJobLogMB:16,...input.limits};
  const toolProfile=input.toolProfile ?? 'core';
  if(!PROFILES.includes(toolProfile))throw new Error('Unknown tool profile');
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions) ||
      Object.keys(permissions).length !== permissionKeys.length ||
      permissionKeys.some(key => typeof permissions[key] !== 'boolean')) throw new Error('Invalid permission settings');
  if (!limits || typeof limits !== 'object' || Array.isArray(limits) ||
      Object.keys(limits).length !== Object.keys(limitRanges).length ||
      Object.keys(limits).some(key => !(key in limitRanges))) throw new Error('Invalid limit settings');
  for (const [key, [min, max]] of Object.entries(limitRanges)) {
    if (!Number.isSafeInteger(limits[key])) throw new Error('Invalid integer limit: ' + key);
    requireInteger(limits[key], null, min, max, key);
  }
  if (limits.maxResourceMB > limits.maxFileMB) throw new Error('Resource size limit cannot exceed file size limit');
  if (!Array.isArray(downloadOrigins) || downloadOrigins.length > 40) throw new Error('Too many allowed download origins');
  const cleanedOrigins = downloadOrigins.map(x => {
    if (typeof x !== 'string' || x.length > 253 || !x.trim()) throw new Error('Invalid download origin');
    const v = x.trim();
    if (/^https:\/\/\*\.[a-z0-9.-]+$/i.test(v) && !v.includes('..')) return v.toLowerCase();
    const url = new URL(v);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Download origins must be HTTPS origins');
    return url.origin;
  });
  if (new Set(cleanedOrigins).size !== cleanedOrigins.length) throw new Error('Duplicate download origins');
  if (!Array.isArray(blockedTools) || blockedTools.length > 200 ||
      blockedTools.some(x => typeof x !== 'string' || (!toolNames.has(x) && !LEGACY_TOOL_NAMES.has(x))) ||
      new Set(blockedTools).size !== blockedTools.length) throw new Error('Unknown or duplicate blocked tool');
  // Accept settings created before OAuth controls were introduced.
  // Older persisted oauth settings have no refresh-token keys. Add safe
  // defaults without modifying any existing access-token or password policy.
  const incomingOAuth = input.oauth === undefined ? defaultOAuth() : input.oauth;
  const security = input.security === undefined ? defaultSecurity() : input.security;
  if (!incomingOAuth || typeof incomingOAuth !== 'object' || Array.isArray(incomingOAuth) ||
      Object.keys(incomingOAuth).some(key => !(key in oauthRanges) && !oauthBooleans.includes(key))) {
    throw new Error('Invalid OAuth configuration');
  }
  // Preserve strict validation for all previously published fields. Only
  // the two newly added refresh settings may be omitted by old state files.
  const legacyKeys = [...Object.keys(oauthRanges).filter(k => k !== 'refreshTokenDays'),
    ...oauthBooleans.filter(k => k !== 'refreshTokensEnabled')];
  if (legacyKeys.some(k => !Object.hasOwn(incomingOAuth,k))) throw new Error('Missing OAuth configuration field');
  const oauth = {...defaultOAuth(),...incomingOAuth};
  for (const [key, [min, max]] of Object.entries(oauthRanges)) { if(!Number.isSafeInteger(oauth[key]))throw new Error('Missing or invalid OAuth value: '+key); requireInteger(oauth[key], null, min, max, key); }
  for (const key of oauthBooleans) if (typeof oauth[key] !== 'boolean') throw new Error('Invalid OAuth switch: ' + key);
  if (!security || typeof security !== 'object' || Array.isArray(security) ||
      Object.keys(security).length !== Object.keys(adminSecurityRanges).length) throw new Error('Invalid session settings');
  for (const [key, [min, max]] of Object.entries(adminSecurityRanges)) {
    if(!Number.isSafeInteger(security[key]))throw new Error('Missing or invalid session value: '+key);
    requireInteger(security[key], null, min, max, key); }
  return { toolProfile, permissions: clone(permissions), limits: clone(limits), downloadOrigins: cleanedOrigins,
    blockedTools: [...blockedTools], oauth: clone(oauth), security: clone(security),
    performance:validatePerformance(input.performance ?? {}) };
}

export class AdminConsole {
  constructor({ config, traces, files, jobs, workspaceBatches, oauth, tools, upstreamNames }) {
    Object.assign(this, { config, traces, files, jobs, workspaceBatches, oauth, tools, upstreamNames });
    this.password = config.adminPassword || config.password || '';
    this.enabled = Boolean(this.password);
    this.names = new Set(tools.map(x => x.name));
    this.filename = path.join(config.dataRoot, 'admin-settings.json');
    this.auditFilename = path.join(config.dataRoot, 'admin-audit.jsonl');
    this.settings = defaultAdminSettings(config);
    this.sessions = new Map();
    this.failedLogins = [];
    this.adminFiles = new AdminFiles(config.workspace);
    this.gitAdmin = new GitAdmin(config);
    this.performance = new PerformanceLog(config.dataRoot);
    this.prevCPU = null;
    this.callTimes = [];
    this.saveQueue = Promise.resolve();
    this.started = Date.now();
  }

  async init() {
    let restored = false;
    try {
      const saved = await readJSON(this.filename);
      if (saved.version !== 1) throw new Error('Unknown admin settings version');
      this.settings = validateAdminSettings(saved.settings, this.names);
      restored = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Preserve exact environment byte limits until a saved admin override exists.
    await this.oauth.setPolicy(this.settings.oauth);
    if (restored) { this.apply(); await this.traces.prune(); }
    else {this.performance.configure(this.settings.performance); this.traces.configureDebug(false);}
  }

  apply() {
    const { limits, downloadOrigins } = this.settings;
    this.files.maxFileBytes = limits.maxFileMB * MiB;
    this.files.maxResourceBytes = limits.maxResourceMB * MiB;
    this.files.allowedOrigins = new Set(downloadOrigins);
    this.adminFiles.maxUploadBytes = limits.maxUploadMB * MiB;
    this.jobs.maxJobs = limits.maxJobs;
    this.jobs.maxJobLogBytes = limits.maxJobLogMB * MiB;
    // New detached coordinators inherit changes; already running ones have a snapshot.
    this.workspaceBatches.config.maxJobs = limits.maxJobs;
    this.traces.maxRecords = limits.traceRetention;
    this.traces.configureDebug(this.settings.performance.enabled);
    this.performance.configure(this.settings.performance);
  }

  async save(input,{allowSensitive=false}={}) {
    const settings = validateAdminSettings(input, this.names);
    const operation = this.saveQueue.then(async () => {
      // The generic settings route must not bypass explicit password
      // confirmation for enabling sensitive request/response capture.
      if(settings.performance.captureContent && !this.settings.performance.captureContent && !allowSensitive)
        throw new Error('Full MCP content capture requires fresh Admin password confirmation in Performance Diagnostics');
      const previousPolicy = this.settings.oauth;
      try { await this.oauth.setPolicy(settings.oauth); }
      catch (error) { await this.oauth.setPolicy(previousPolicy); throw error; }
      try { await atomicJSON(this.filename, { version: 1, saved_at: new Date().toISOString(), settings }); }
      catch (error) { await this.oauth.setPolicy(previousPolicy); throw error; }
      this.settings = settings;
      this.apply();
      await this.traces.prune();
      await this.audit('settings.update');
      return { settings: clone(settings), saved: true };
    });
    this.saveQueue = operation.catch(() => {});
    return operation;
  }

  async audit(action) {
    // Never persist passwords, tokens, file contents or command arguments.
    await appendFile(this.auditFilename, JSON.stringify({ at: new Date().toISOString(), action }) + '\n', { mode: 0o600 });
  }

  allowed(name, args={}) {
    if (!this.names.has(name)) return false;
    return !denialReason(this.settings,name,args,this.upstreamNames.has(name));
  }

  enforce(name, args = {}) {
    if(!this.names.has(name))throw new Error('Unknown tool; inspect dev_get_guide catalog and refresh the client actions');
    const denial=denialReason(this.settings,name,args,this.upstreamNames.has(name));
    if(denial)throw new Error('This MCP tool is ' + denial);
    // Recovery and cancellation are never starved by the work admission rate.
    if(['dev_get_guide','job_read','job_list','job_cancel','workspace_read','workspace_list','workspace_cancel'].includes(name))return args;
    const lim = this.settings.limits;
    const now = Date.now();
    this.callTimes = this.callTimes.filter(x => x > now - 60000);
    if (lim.callsPerMinute && this.callTimes.length >= lim.callsPerMinute) throw new Error('MCP calls per minute limit reached');
    this.callTimes.push(now);
    if (name === 'job_start') {
      if (args.timeout_seconds !== undefined && args.timeout_seconds > lim.maxJobSeconds) throw new Error('Job timeout exceeds the admin limit');
      return { ...args, timeout_seconds: args.timeout_seconds ?? Math.min(3600, lim.maxJobSeconds) };
    }
    if (name === 'workspace_execute') {
      if (!Array.isArray(args.steps)) return args;
      if (args.steps.length > lim.maxBatchSteps) throw new Error('Batch step count exceeds the admin limit');
      if (args.parallelism !== undefined && args.parallelism > lim.maxParallelism) throw new Error('Batch parallelism exceeds the admin limit');
      if (args.timeout_seconds !== undefined && args.timeout_seconds > lim.maxJobSeconds) throw new Error('Batch timeout exceeds the admin limit');
      const steps = args.steps.map(step => {
        if (step.type === 'container_build' && (!this.settings.permissions.containerBuild || !this.settings.permissions.commandExecution)) throw new Error('Container builds are disabled');
        if (step.type === 'container_build' && step.timeout_seconds !== undefined && step.timeout_seconds > lim.maxJobSeconds) throw new Error('Build timeout exceeds the admin limit');
        if (step.type === 'exec' && !this.settings.permissions.commandExecution) throw new Error('Command execution is disabled');
        if (step.type === 'exec' && step.timeout_seconds !== undefined && step.timeout_seconds > lim.maxJobSeconds) throw new Error('Step timeout exceeds the admin limit');
        if(step.type==='container_build')return {...step,timeout_seconds:step.timeout_seconds ?? Math.min(600,lim.maxJobSeconds)};
        if(step.type==='http_check' && step.timeout_seconds>lim.maxJobSeconds)throw new Error('HTTP check timeout exceeds the admin limit');
        return step.type === 'exec' ? { ...step, timeout_seconds: step.timeout_seconds ?? Math.min(step.background ? 86400 : 3600, lim.maxJobSeconds) } : step;
      });
      return { ...args, steps, parallelism: args.parallelism ?? lim.maxParallelism,
        timeout_seconds: args.timeout_seconds ?? Math.min(3600, lim.maxJobSeconds) };
    }
    return args;
  }

  visibleTools() { return this.tools.filter(x => this.allowed(x.name)); }

  session(req) {
    const match = /(?:^|;\s*)mcp_admin_session=([^;]+)/.exec(req.headers.cookie || '');
    const s = match ? this.sessions.get(match[1]) : null;
    if (!s) return null;
    if (s.expires < Date.now()) { this.sessions.delete(match[1]); return null; }
    return s;
  }
  cookie(value, expired = false) {
    return 'mcp_admin_session=' + value + '; Path=/admin; HttpOnly; SameSite=Strict' +
      (this.config.publicBaseURL ? '; Secure' : '') + (expired ? '; Max-Age=0' : '; Max-Age=' +
        this.settings.security.adminSessionMinutes * 60);
  }

  async activity(offset = 0, limit = 50) {
    const files = (await readdir(this.traces.root)).filter(x => /^\d+-[a-f0-9-]{36}\.json$/.test(x)).sort().reverse();
    const items = await Promise.all(files.slice(offset, offset + limit).map(async file => {
      try { return await readJSON(path.join(this.traces.root, file)); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }));
    return { total: files.length, calls: items.filter(Boolean), offset, limit };
  }

  async metrics() {
    const cpus = os.cpus();
    const current = cpus.reduce((acc, core) => {
      for (const [k, val] of Object.entries(core.times)) acc[k] = (acc[k] || 0) + val;
      return acc;
    }, {});
    let cpuPercent = null;
    if (this.prevCPU) {
      const total = Object.values(current).reduce((a, b) => a + b, 0);
      const past = Object.values(this.prevCPU).reduce((a, b) => a + b, 0);
      const delta = total - past;
      if (delta > 0) cpuPercent = Math.max(0, Math.min(100, 100 * (1 - (current.idle - this.prevCPU.idle) / delta)));
    }
    this.prevCPU = current;
    let disk = null;
    try {
      const s = await statfs(this.config.workspace, { bigint: false });
      disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
    } catch {}
    return {
      cpu_percent: cpuPercent, cpu_count: cpus.length, load: os.loadavg(),
      memory_total: os.totalmem(), memory_free: os.freemem(),
      disk, process_rss: process.memoryUsage().rss,
      host_uptime: os.uptime(), process_uptime: process.uptime(),
      platform: os.platform(), node: process.version, sampled_at: new Date().toISOString()
    };
  }

  async overview() {
    const [activity, allJobs, allBatches, system] = await Promise.all([
      this.activity(0, 240), this.jobs.list(), this.workspaceBatches.list(), this.metrics()
    ]);
    const now = Date.now();
    const calls = activity.calls;
    const recent = calls.filter(x => now - Date.parse(x.started_at) < 15 * 60 * 1000);
    const activeJobs = allJobs.filter(x => ['queued', 'running'].includes(x.status));
    const activeBatches = allBatches.executions.filter(x => ['queued', 'running'].includes(x.status));
    const histogram = Array.from({ length: 24 }, (_v, i) => {
      const begin = now - (24 - i) * 5 * 60 * 1000;
      return calls.filter(x => Date.parse(x.started_at) >= begin && Date.parse(x.started_at) < begin + 5 * 60 * 1000).length;
    });
    return { system, calls: { total: activity.total, recent_15m: recent.length, active: calls.filter(x => x.status === 'running').length,
      errors_15m: recent.filter(x => x.status === 'error').length, histogram, latest: calls.slice(0, 8) },
      jobs: { total: allJobs.length, active: activeJobs.length, latest: allJobs.slice(0, 5).map(this.safeJob) },
      batches: { total: allBatches.executions.length, active: activeBatches.length, latest: allBatches.executions.slice(0, 5) } };
  }
  safeJob(job) {
    const { id, cwd, status, exit_code, created_at, started_at, finished_at, trace_id, batch_execution_id } = job;
    return { id, cwd, status, exit_code, created_at, started_at, finished_at, trace_id, batch_execution_id };
  }

  async handle(req, res, url, readBody, json) {
    if (!this.enabled || !url.pathname.startsWith('/admin')) return false;
    const p = url.pathname;
    if (p === '/admin') { res.writeHead(302, { Location: '/admin/', 'Cache-Control': 'no-store' }); res.end(); return true; }
    const assets = { '/admin/': ['web/admin.html', 'text/html; charset=utf-8'],
      '/admin/app.css': ['web/admin.css', 'text/css; charset=utf-8'],
      '/admin/app.js': ['web/admin.js', 'application/javascript; charset=utf-8'] };
    if (req.method === 'GET' && assets[p]) {
      const [filename, mime] = assets[p];
      const bytes = await readFile(path.join(rootDir, filename));
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
      res.end(bytes);
      return true;
    }
    if (!p.startsWith('/admin/api/')) { json(res, 404, { error: 'Not found' }); return true; }
    if (p === '/admin/api/login' && req.method === 'POST') {
      const now = Date.now();
      this.failedLogins = this.failedLogins.filter(x => now - x < 15 * 60 * 1000);
      if (this.failedLogins.length >= 10) { json(res, 429, { error: 'Too many attempts. Retry later.' }); return true; }
      const data = JSON.parse(await readBody(req, 2048));
      if (!equal(data.password, this.password)) {
        this.failedLogins.push(now); json(res, 401, { error: 'Invalid password' }); return true;
      }
      this.failedLogins = [];
      for (const [key, s] of this.sessions) if (s.expires < now) this.sessions.delete(key);
      if (this.sessions.size > 128) this.sessions.delete(this.sessions.keys().next().value);
      const sid = token();
      this.sessions.set(sid, { csrf: token(), expires: now + this.settings.security.adminSessionMinutes * 60000 });
      res.setHeader('Set-Cookie', this.cookie(sid));
      await this.audit('session.login');
      json(res, 200, { ok: true }); return true;
    }
    const session = this.session(req);
    if (p === '/admin/api/session' && req.method === 'GET') {
      json(res, 200, session ? { authenticated: true, csrf: session.csrf } : { authenticated: false }); return true;
    }
    if (!session) { json(res, 401, { error: 'Admin login required' }); return true; }
    if (!['GET', 'HEAD'].includes(req.method) && !equal(req.headers['x-csrf-token'], session.csrf)) {
      json(res, 403, { error: 'Invalid CSRF token' }); return true;
    }
    if (p === '/admin/api/logout' && req.method === 'POST') {
      const sid = /(?:^|;\s*)mcp_admin_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
      this.sessions.delete(sid);
      res.setHeader('Set-Cookie', this.cookie('', true));
      json(res, 200, { ok: true }); return true;
    }

    if (req.method === 'GET' && p === '/admin/api/overview') { json(res, 200, await this.overview()); return true; }
    if (req.method === 'GET' && p === '/admin/api/activity') {
      json(res, 200, await this.activity(requireInteger(Number(url.searchParams.get('offset') || 0), 0, 0, 20000, 'offset'),
        requireInteger(Number(url.searchParams.get('limit') || 50), 50, 1, 100, 'limit'))); return true;
    }
    if (req.method === 'GET' && p === '/admin/api/jobs') {
      json(res, 200, { jobs: (await this.jobs.list()).slice(0, 150).map(this.safeJob) }); return true;
    }
    if (req.method === 'GET' && p === '/admin/api/batches') {
      json(res, 200, await this.workspaceBatches.list()); return true;
    }
    const cancelJob = /^\/admin\/api\/jobs\/([a-f0-9-]{36})\/cancel$/.exec(p);
    if (cancelJob && req.method === 'POST') {
      const result = await this.jobs.cancel({ job_id: cancelJob[1] });
      await this.audit('job.cancel'); json(res, 200, this.safeJob(result)); return true;
    }
    const cancelBatch = /^\/admin\/api\/batches\/([a-f0-9-]{36})\/cancel$/.exec(p);
    if (cancelBatch && req.method === 'POST') {
      await this.workspaceBatches.cancel({ execution_id: cancelBatch[1] });
      await this.audit('batch.cancel'); json(res, 200, { ok: true }); return true;
    }
    if(p==='/admin/api/tools' && req.method==='GET') {
      json(res,200,this.catalog?.() || {error:'Tool catalog unavailable'});return true;
    }
    if (p === '/admin/api/settings') {
      if (req.method === 'GET') {
        json(res, 200, { catalog:this.catalog?.(), settings: clone(this.settings), tools: this.tools.map(t => ({ name: t.name, title: t.title || t.name, origin: this.upstreamNames.has(t.name) ? 'Desktop Commander' : 'MCP Gateway' })),
          connection: { publicBaseURL: this.config.publicBaseURL || '', mcpPath: '/mcp', workspace: this.config.workspace,
            host: this.config.host || '127.0.0.1', port: this.config.port || 8787,
            oauthRedirectOrigins: this.config.clientRedirectOrigins || [], adminPath: '/admin/' },
          note: 'OAuth policy and limits apply to new actions immediately. Issued tokens keep their original expiry; restart persistence applies only when enabled. Host, port, OAuth redirect origins and environment owner password require a service restart.' }); return true;
      }
      if (req.method === 'PUT') { json(res, 200, await this.save(JSON.parse(await readBody(req, 32768)))); return true; }
    }
    // The Git manager targets the unprivileged command runner, not the
    // Admin process user. It never exposes private-key material in responses.
    if (p === '/admin/api/git' && req.method === 'GET') {
      json(res, 200, await this.gitAdmin.run('status')); return true;
    }
    const gitAction = /^\/admin\/api\/git\/(identity|generate|adopt|import|remove|test|bind)$/.exec(p);
    if (gitAction && req.method === 'POST') {
      const action = gitAction[1];
      const body = JSON.parse(await readBody(req, 22000));
      if (!body || typeof body !== 'object' || Array.isArray(body))
        throw new Error('Invalid Git administration payload');
      if (['adopt', 'import', 'remove'].includes(action) && !equal(body.password, this.password)) {
        json(res, 403, { error:'Admin password confirmation failed' }); return true;
      }
      // Pass only explicitly expected fields to the ephemeral worker.
      const payload = action === 'identity' ? {name:body.name,email:body.email} :
        action === 'import' ? {repository:body.repository,privateKey:body.privateKey} :
        action === 'bind' ? {repository:body.repository,cwd:body.cwd} :
        {repository:body.repository};
      const result=await this.gitAdmin.run(action,payload);
      await this.audit('git.'+action);
      json(res,200,result);
      return true;
    }
    if (p === '/admin/api/performance' && req.method === 'GET') {
      const limit=requireInteger(Number(url.searchParams.get('limit') || 100),100,1,500,'limit');
      json(res,200,await this.performance.summary(limit)); return true;
    }
    if (p === '/admin/api/performance/trace' && req.method === 'GET') {
      const trace_id=url.searchParams.get('trace_id');
      if(!trace_id)throw new Error('trace_id is required');
      json(res,200,await this.traces.read({trace_id,limit:1})); return true;
    }
    if (p === '/admin/api/performance/download' && req.method === 'GET') {
      const body=await this.performance.download();
      res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8',
        'Content-Disposition':'attachment; filename="mcp-performance.jsonl"',
        'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
        'Content-Length':body.length});
      res.end(body);return true;
    }
    // Content logs can include API keys, Shell commands and files. Reading
    // and exporting them require a fresh Admin password AND session + CSRF.
    if (p === '/admin/api/performance/content/read' && req.method === 'POST') {
      const data=JSON.parse(await readBody(req,4096));
      if(!equal(data.password,this.password)){
        json(res,403,{error:'Admin password confirmation failed'});return true;
      }
      const record=await this.performance.readContent(data.capture_id);
      if(!record){json(res,404,{error:'Capture expired, not available or truncated from retention'});return true;}
      json(res,200,record);return true;
    }
    if (p === '/admin/api/performance/content/download' && req.method === 'POST') {
      const data=JSON.parse(await readBody(req,2048));
      if(!equal(data.password,this.password)){
        json(res,403,{error:'Admin password confirmation failed'});return true;
      }
      const body=await this.performance.downloadContent();
      res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8',
        'Content-Disposition':'attachment; filename="mcp-content-sensitive.jsonl"',
        'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',
        'X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'none'",
        'Content-Length':body.length});
      res.end(body);return true;
    }
    if (p === '/admin/api/performance' && req.method === 'PUT') {
      const submitted=JSON.parse(await readBody(req,4096));
      const {password,...input}=submitted;
      const verified=validatePerformance(input);
      if(verified.captureContent && !this.settings.performance.captureContent && !equal(password,this.password)){
        json(res,403,{error:'Enabling full MCP payload capture requires the Admin password'});return true;
      }
      await this.save({...this.settings,performance:verified},{allowSensitive:verified.captureContent===true && equal(password,this.password)});
      json(res,200,{settings:{...this.settings.performance},saved:true});return true;
    }
    if (p === '/admin/api/performance/clear' && req.method === 'POST') {
      const submitted=JSON.parse(await readBody(req,2048));
      if(!equal(submitted.password,this.password)){
        json(res,403,{error:'Admin password confirmation failed'});return true;
      }
      await this.performance.clear();
      await this.audit('performance.clear');
      json(res,200,{cleared:true});return true;
    }
    if (p === '/admin/api/oauth/status' && req.method === 'GET') {
      json(res, 200, this.oauth.status()); return true;
    }
    if (p === '/admin/api/oauth/bearer/rotate' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req, 2048));
      if (!equal(body.password, this.password)) { json(res, 403, { error: 'Admin password confirmation failed' }); return true; }
      // Audit before rotation, so a failed audit write cannot lose the once-only key response.
      await this.audit('oauth.bearer.rotate.request');
      const result = await this.oauth.rotateManagedBearer(body.days);
      json(res, 200, result); return true;
    }
    if (p === '/admin/api/oauth/bearer/revoke' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req, 2048));
      if (!equal(body.password, this.password)) { json(res, 403, { error: 'Admin password confirmation failed' }); return true; }
      await this.oauth.revokeManagedBearer();
      await this.audit('oauth.bearer.revoke');
      json(res, 200, { ok: true }); return true;
    }
    if (p === '/admin/api/oauth/tokens/revoke' && req.method === 'POST') {
      await this.oauth.revokeAllAccessTokens();
      await this.audit('oauth.tokens.revoke');
      json(res, 200, { ok: true }); return true;
    }
    if (p === '/admin/api/oauth/clients/revoke' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req, 2048));
      if (typeof body.client_id !== 'string' || body.client_id.length > 256) {
        json(res, 400, { error: 'Invalid OAuth client ID' }); return true;
      }
      await this.oauth.revokeClient(body.client_id);
      await this.audit('oauth.client.revoke');
      json(res, 200, { ok: true }); return true;
    }
    if(p.startsWith('/admin/api/files') && req.method==='GET' && !this.settings.permissions.filesystemRead){json(res,403,{error:'Filesystem reading is disabled'});return true;}
    if (p === '/admin/api/files' && req.method === 'GET') {
      json(res, 200, { ...await this.adminFiles.list(url.searchParams.get('path') || '.'), writable: this.settings.permissions.fileManagerWrite && this.settings.permissions.filesystemWrite }); return true;
    }
    if (p === '/admin/api/files/text' && req.method === 'GET') {
      json(res, 200, await this.adminFiles.text(url.searchParams.get('path'))); return true;
    }
    if (p === '/admin/api/files/download' && req.method === 'GET') {
      const { file, name, size } = await this.adminFiles.reader(url.searchParams.get('path'), 1024 * MiB);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': size, 'Cache-Control': 'no-store',
        'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name) });
      await pipeline(file.createReadStream({ autoClose: true }), res); return true;
    }
    if (p.startsWith('/admin/api/files/') && ['POST', 'PUT'].includes(req.method)) {
      if (!this.settings.permissions.fileManagerWrite || !this.settings.permissions.filesystemWrite) { json(res, 403, { error: 'File manager is read-only' }); return true; }
      let result;
      if (p === '/admin/api/files/upload' && req.method === 'PUT') {
        result = await this.adminFiles.upload(url.searchParams.get('path'), req, Math.min(this.files.maxFileBytes, this.adminFiles.maxUploadBytes));
      } else {
        const body = JSON.parse(await readBody(req, 2 * MiB));
        if (p === '/admin/api/files/save') result = await this.adminFiles.save(body.path, body.content);
        else if (p === '/admin/api/files/mkdir') result = await this.adminFiles.createDirectory(body.path);
        else if (p === '/admin/api/files/rename') result = await this.adminFiles.move(body.from, body.to);
        else if (p === '/admin/api/files/delete') result = await this.adminFiles.remove(body.path);
      }
      if (result) { await this.audit('files.' + p.split('/').at(-1)); json(res, 200, result); return true; }
    }
    json(res, 404, { error: 'Unknown admin endpoint' }); return true;
  }
}
