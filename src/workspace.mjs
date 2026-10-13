import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJSON, readJSON, requireInteger, isInside } from './common.mjs';
import { parsePatch } from './patch.mjs';
import { currentTrace } from './trace.mjs';
import { processIdentity } from './jobs.mjs';

export const batchTerminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const workerPath = fileURLToPath(new URL('./workspace-worker.mjs', import.meta.url));
const stepID = /^[A-Za-z0-9_-]{1,64}$/;

function relative(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\0') || path.isAbsolute(value) || !isInside('/workspace', path.resolve('/workspace', value))) throw new Error(`${label} must be a workspace-relative path without traversal`);
  return value;
}

export function validatePlan(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Batch arguments must be an object');
  const allowedKeys = new Set(['steps', 'cwd', 'parallelism', 'timeout_seconds', 'stop_on_error', 'cleanup_background_on_failure', 'max_output_bytes', 'request_id', 'wait_ms']);
  if (Object.keys(args).some(key => !allowedKeys.has(key))) throw new Error('Unknown batch argument');
  if (Buffer.byteLength(JSON.stringify(args)) > 768 * 1024) throw new Error('Batch inputs exceed 768 KiB');
  if (!Array.isArray(args.steps) || !args.steps.length || args.steps.length > 32) throw new Error('steps must contain 1..32 steps');
  if (args.request_id !== undefined && (typeof args.request_id !== 'string' || !stepID.test(args.request_id))) throw new Error('request_id must contain 1..64 letters, digits, underscores or hyphens');
  for (const key of ['stop_on_error', 'cleanup_background_on_failure']) if (args[key] !== undefined && typeof args[key] !== 'boolean') throw new Error(`${key} must be boolean`);
  const plan = {
    cwd: relative(args.cwd ?? '.', 'cwd'),
    parallelism: requireInteger(args.parallelism, 4, 1, 4, 'parallelism'),
    timeout_seconds: requireInteger(args.timeout_seconds, 3600, 1, 86400, 'timeout_seconds'),
    stop_on_error: args.stop_on_error ?? true,
    cleanup_background_on_failure: args.cleanup_background_on_failure ?? true,
    max_output_bytes: requireInteger(args.max_output_bytes, 8192, 256, 32768, 'max_output_bytes'),
    steps: []
  };
  const ids = new Set();
  for (let i = 0; i < args.steps.length; i++) {
    const input = args.steps[i];
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`Invalid step ${i + 1}`);
    const fields = { write: ['path', 'content', 'expected_sha256', 'create_only'], mkdir: ['path'], patch: ['patch', 'expected_sha256'], container_build: ['context', 'dockerfile', 'output', 'network', 'timeout_seconds'], exec: ['argv', 'command', 'cwd', 'env', 'background', 'timeout_seconds'], http_check: ['url', 'method', 'expected_status', 'timeout_seconds', 'retry_interval_ms'] }[input.type];
    if (!Array.isArray(fields) || Object.keys(input).some(key => !['id', 'type', 'depends_on', ...fields].includes(key))) throw new Error(`Unknown step type or field in step ${i + 1}`);
    const id = input.id ?? `step_${i + 1}`;
    if (typeof id !== 'string' || !stepID.test(id) || ids.has(id)) throw new Error('Step IDs must be unique and contain 1..64 letters, digits, underscores or hyphens');
    ids.add(id);
    const depends_on = input.depends_on ?? (i ? [plan.steps[i - 1].id] : []);
    if (!Array.isArray(depends_on) || depends_on.some(dependency => typeof dependency !== 'string') || new Set(depends_on).size !== depends_on.length) throw new Error(`Invalid depends_on for ${id}`);
    const step = { id, type: input.type, depends_on };
    if (input.type === 'write' || input.type === 'mkdir') {
      step.path = relative(input.path, `${id}.path`);
      if (input.type === 'write') {
        if (typeof input.content !== 'string') throw new Error(`Write step ${id} requires content`);
        if (input.expected_sha256 !== undefined && (typeof input.expected_sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(input.expected_sha256))) throw new Error(`Invalid expected_sha256 for ${id}`);
        if(input.create_only!==undefined&&typeof input.create_only!=='boolean')throw new Error('create_only must be boolean');
        if(input.create_only&&input.expected_sha256)throw new Error('create_only cannot be combined with expected_sha256');
        if(input.create_only)step.create_only=true;
        step.content = input.content;
        if (input.expected_sha256) step.expected_sha256 = input.expected_sha256.toLowerCase();
      }
    } else if (input.type === 'container_build') {
      if (!['none', 'private'].includes(input.network ?? 'none')) throw new Error('container_build network must be none or private');
      Object.assign(step, { context: relative(input.context ?? '.', `${id}.context`), dockerfile: relative(input.dockerfile ?? 'Dockerfile', `${id}.dockerfile`),
        output: relative(input.output ?? 'image.tar', `${id}.output`), network: input.network ?? 'none', timeout_seconds: requireInteger(input.timeout_seconds, 600, 1, 900, `${id}.timeout_seconds`) });
    } else if (input.type === 'patch') {
      parsePatch(input.patch);
      const guards = input.expected_sha256 ?? {};
      if (!guards || Array.isArray(guards) || typeof guards !== 'object' || Object.entries(guards).some(([key, value]) => typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value))) throw new Error('Patch expected_sha256 must map file paths to SHA-256 hashes');
      Object.assign(step, { patch: input.patch, expected_sha256: Object.fromEntries(Object.entries(guards).map(([key, value]) => [key, value.toLowerCase()])) });
    } else if (input.type === 'exec') {
      if ((input.argv !== undefined) === (input.command !== undefined)) throw new Error(`Exec step ${id} requires exactly one of argv or command`);
      const argv = input.argv ?? (typeof input.command === 'string' && input.command ? ['bash', '--noprofile', '--norc', '-c', input.command] : null);
      if (!Array.isArray(argv) || !argv.length || !argv[0] || argv.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error(`Invalid command for ${id}`);
      if (input.background !== undefined && typeof input.background !== 'boolean') throw new Error(`Invalid background for ${id}`);
      const env = input.env ?? {};
      if (!env || Array.isArray(env) || typeof env !== 'object' || Object.entries(env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0'))) throw new Error(`Invalid env for ${id}`);
      Object.assign(step, { argv, cwd: relative(input.cwd ?? '.', `${id}.cwd`), env, background: input.background ?? false,
        timeout_seconds: requireInteger(input.timeout_seconds, input.background ? 86400 : 3600, 1, 86400, `${id}.timeout_seconds`) });
    } else if (input.type === 'http_check') {
      const url = new URL(input.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error(`Invalid HTTP URL for ${id}`);
      if (!['GET', 'HEAD'].includes(input.method ?? 'GET')) throw new Error(`Invalid HTTP method for ${id}`);
      Object.assign(step, { url: url.href, method: input.method ?? 'GET',
        expected_status: requireInteger(input.expected_status, 200, 100, 599, `${id}.expected_status`),
        timeout_seconds: requireInteger(input.timeout_seconds, 15, 1, 120, `${id}.timeout_seconds`),
        retry_interval_ms: requireInteger(input.retry_interval_ms, 300, 100, 5000, `${id}.retry_interval_ms`) });
    } else throw new Error(`Unknown step type for ${id}`);
    plan.steps.push(step);
  }
  const byID = new Map(plan.steps.map(step => [step.id, step]));
  const visited = new Set();
  const visiting = new Set();
  function visit(id) {
    if (!byID.has(id)) throw new Error(`Unknown dependency: ${id}`);
    if (visiting.has(id)) throw new Error('Batch dependencies contain a cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byID.get(id).depends_on) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of ids) visit(id);
  const ancestors = id => {const set=new Set();const walk=x=>{for(const d of byID.get(x).depends_on){if(!set.has(d)){set.add(d);walk(d);}}};walk(id);return set;};
  const writes=new Map();
  for(const step of plan.steps){
    const paths=step.type==='write'?[step.path]:step.type==='patch'?parsePatch(step.patch).map(f=>f.path):[];
    for(const file of paths){
      const key=path.posix.normalize(file);
      for(const earlier of writes.get(key)||[]){
        if(!ancestors(step.id).has(earlier)&&!ancestors(earlier).has(step.id))throw new Error('Parallel writes conflict for '+key+'; add explicit depends_on edges');
      }
      writes.set(key,[...(writes.get(key)||[]),step.id]);
    }
  }
  return plan;
}

export class Workspace {
  constructor(config, jobs) {
    this.jobs = jobs;
    this.config = Object.fromEntries(['workspace', 'dataRoot', 'maxJobs', 'maxJobLogBytes', 'executionUid', 'executionGid', 'executionHome', 'executionEnv', 'containerBuildSocket'].map(key => [key, config[key]]));
    this.root = path.join(config.dataRoot, 'batches');
    this.requests = path.join(config.dataRoot, 'batch-requests');
    this.launchQueue = Promise.resolve();
  }

  async init() { await mkdir(this.root, { recursive: true, mode: 0o700 }); await mkdir(this.requests, { recursive: true, mode: 0o700 }); }

  directory(id) {
    if (!/^[a-f0-9-]{36}$/.test(id ?? '')) throw new Error('Invalid execution ID');
    return path.join(this.root, id);
  }

  async execute(args) {
    const plan = validatePlan(args);
    for(const step of plan.steps){
      const targets=step.type==='patch'?parsePatch(step.patch).map(f=>f.path):['write','mkdir'].includes(step.type)?[step.path]:[];
      for(const file of targets)if(isInside(this.config.dataRoot,path.resolve(this.config.workspace,plan.cwd,file)))throw new Error('Batch cannot edit private MCP state');
    }
    const wait_ms = requireInteger(args.wait_ms, 1000, 0, 10000, 'wait_ms');
    const pending = this.launchQueue.then(() => this.jobs.withAdmissionLock(() => this.launch(plan, args.request_id)));
    this.launchQueue = pending.catch(() => {});
    const id = await pending;
    const deadline = Date.now() + wait_ms;
    while (Date.now() < deadline) {
      if (batchTerminal.has((await this.status(id)).status)) break;
      await delay(Math.min(100, deadline - Date.now()));
    }
    return this.read({ execution_id: id });
  }

  async launch(plan, requestID) {
    const hash = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
    const requestFile = requestID ? path.join(this.requests, `${requestID}.json`) : null;
    if (requestFile) {
      try {
        const previous = await readJSON(requestFile);
        if (previous.hash !== hash) throw new Error('request_id already belongs to a different batch; choose a new ID');
        return previous.id;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const id = randomUUID();
    const dir = this.directory(id);
    await mkdir(dir, { mode: 0o700 });
    await atomicJSON(path.join(dir, 'plan.json'), plan);
    await atomicJSON(path.join(dir, 'state.json'), { execution_id: id, cwd: plan.cwd, request_id: requestID, trace_id: currentTrace(), status: 'queued', revision: 0, created_at: new Date().toISOString(),
      steps: plan.steps.map(({ id, type, depends_on, background }) => ({ id, type, depends_on, background: background ?? false, status: 'pending' })) });
    if (requestFile) await atomicJSON(requestFile, { id, hash });
    const worker = spawn(process.execPath, [workerPath, dir], { detached: true, stdio: 'ignore',
      env: { PATH: process.env.PATH, LANG: process.env.LANG || 'C.UTF-8', BATCH_CONFIG: JSON.stringify(this.config) } });
    try {
      await new Promise((resolve, reject) => { worker.once('spawn', resolve); worker.once('error', reject); });
      await atomicJSON(path.join(dir, 'owner.json'), { pid: worker.pid, starttime: await processIdentity(worker.pid) });
      worker.unref();
    } catch (error) {
      const state = await readJSON(path.join(dir, 'state.json'));
      Object.assign(state, { status: 'failed', error: error.message, finished_at: new Date().toISOString() });
      await atomicJSON(path.join(dir, 'state.json'), state);
      throw error;
    }
    return id;
  }

  async status(id) {
    const dir = this.directory(id);
    const state = await readJSON(path.join(dir, 'state.json'));
    if (!batchTerminal.has(state.status)) {
      let owner;
      try { owner = await readJSON(path.join(dir, 'owner.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if ((owner && (!owner.starttime || await processIdentity(owner.pid) !== owner.starttime)) || (!owner && Date.now() - Date.parse(state.created_at) > 30000)) {
        const latest = await readJSON(path.join(dir, 'state.json'));
        if (!batchTerminal.has(latest.status)) {
          for (const job of (await this.jobs.list()).filter(job => job.batch_execution_id === id)) {
            const step = latest.steps.find(step => step.id === job.batch_step_id);
            if (step && !step.job_id) step.job_id = job.id;
          }
          Object.assign(latest, { status: 'interrupted', error: 'Batch coordinator exited. Inspect recorded job IDs before retrying.', finished_at: new Date().toISOString() });
          await atomicJSON(path.join(dir, 'state.json'), latest);
        }
        return latest;
      }
    }
    return state;
  }

  async read({ execution_id, offset = 0, max_bytes, wait_ms }) {
    offset = requireInteger(offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
    const limit = requireInteger(max_bytes, 32768, 1, 262144, 'max_bytes');
    const wait = requireInteger(wait_ms, 0, 0, 10000, 'wait_ms');
    let state = await this.status(execution_id);
    const revision = state.revision;
    const deadline = Date.now() + wait;
    while (!batchTerminal.has(state.status) && Date.now() < deadline && state.revision === revision) {
      await delay(Math.min(100, deadline - Date.now()));
      state = await this.status(execution_id);
    }
    let output = '', next_offset = offset, has_more = false;
    try {
      const file = await open(path.join(this.directory(execution_id), 'output.log'), 'r');
      try {
        const buffer = Buffer.alloc(limit);
        const { bytesRead } = await file.read(buffer, 0, limit, offset);
        output = buffer.subarray(0, bytesRead).toString('utf8');
        next_offset += bytesRead;
        has_more = (await file.stat()).size > next_offset;
      } finally { await file.close(); }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const background_jobs = [];
    for (const step of state.steps) if (step.background && step.job_id) {
      try { const job = await this.jobs.status(step.job_id); background_jobs.push({ step_id: step.id, job_id: job.id, status: job.status, exit_code: job.exit_code }); }
      catch (error) { background_jobs.push({ step_id: step.id, job_id: step.job_id, error: error.message }); }
    }
    return { ...state, output, next_offset, has_more, background_jobs,
      next_step: batchTerminal.has(state.status) ? 'Inspect every step status and exit code. Started background services are still separate jobs: monitor or stop with job_read/job_cancel. Drain truncated step logs with job_read using the step job_id and next_offset.' : 'Poll workspace_read with execution_id, next_offset and wait_ms=1000..10000. Do not resubmit the plan without its original request_id.' };
  }

  async list() {
    const ids = (await readdir(this.root)).filter(id => /^[a-f0-9-]{36}$/.test(id));
    const states = await Promise.all(ids.map(id => this.status(id)));
    return { executions: states.sort((a, b) => b.created_at.localeCompare(a.created_at)).map(({ execution_id, trace_id, cwd, request_id, status, created_at, finished_at }) => ({ execution_id, trace_id, cwd, request_id, status, created_at, finished_at })) };
  }

  async cancel({ execution_id }) {
    const dir = this.directory(execution_id);
    const state = await this.status(execution_id);
    await writeFile(path.join(dir, 'cancel'), '', { mode: 0o600 });
    if (!batchTerminal.has(state.status) && state.started_at) {
      try {
        const owner = await readJSON(path.join(dir, 'owner.json'));
        if (owner.starttime && await processIdentity(owner.pid) === owner.starttime) process.kill(-owner.pid, 'SIGTERM');
      } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
    }
    const associated = (await this.jobs.list()).filter(job => job.batch_execution_id === execution_id);
    const cancellations = await Promise.allSettled(associated.map(job => this.jobs.cancel({ job_id: job.id })));
    return { ...(await this.read({ execution_id })), cancellation_requested: true,
      cancellation_errors: cancellations.filter(result => result.status === 'rejected').map(result => result.reason.message) };
  }
}

const stepSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string', description: 'Unique step ID. Defaults to step_1, step_2, etc.' },
    type: { type: 'string', enum: ['write', 'mkdir', 'patch', 'container_build', 'exec', 'http_check'] },
    depends_on: { type: 'array', items: { type: 'string' }, description: 'Omit to depend on previous step; [] means independent. Explicit dependencies enable bounded parallel execution.' },
    path: { type: 'string', description: 'write/mkdir: path relative to batch cwd. Parent directories are created.' },
    create_only: {type:'boolean',description:'write: atomically refuse an already existing path. Use for new files.'},
    content: { type: 'string', description: 'write: complete UTF-8 content, required. Files are atomically replaced.' },
    context: { type: 'string', description: 'container_build: context directory relative to batch cwd, default dot. Symlinks/special files rejected; common secrets, .git, node_modules and target excluded. Use a minimal context; .dockerignore is processed by builder, not a secret filter.' },
    dockerfile: { type: 'string', description: 'container_build: Dockerfile path relative to context, default Dockerfile.' },
    output: { type: 'string', description: 'container_build: new docker-archive output path relative to batch cwd, default image.tar. Refuses overwrite; export with file_export.' },
    network: { type: 'string', enum: ['none', 'private'], description: 'container_build: RUN network defaults to none. private enables slirp outbound networking; no host network mode. Base image pulls can still use registry network.' },
    patch: { type: 'string', description: 'patch: standard unified diff with ---/+++ and numbered @@ hunks. Exact positions/context, no fuzzy matching. Supports text adds/updates/deletes. Preflights all files; each replacement atomic, ordinary errors attempt rollback, not crash-atomic across files.' },
    expected_sha256: { oneOf: [{ type: 'string' }, { type: 'object', additionalProperties: { type: 'string' } }], description: 'write: current-file hash. patch: map of project-relative paths to hashes. Mismatch fails without editing.' },
    argv: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'exec: executable and arguments. Specify argv or command.' },
    command: { type: 'string', description: 'exec: explicit shell command run via bash --noprofile --norc -c. Specify command or argv.' },
    cwd: { type: 'string', description: 'exec: working directory relative to batch cwd; defaults to dot.' },
    env: { type: 'object', additionalProperties: { type: 'string' } },
    background: { type: 'boolean', default: false, description: 'exec: start a durable service and continue. A started step is not proof of readiness; follow it with http_check. Background jobs remain after successful batch completion.' },
    timeout_seconds: { type: 'integer', minimum: 1, maximum: 86400, description: 'exec: default 3600, or 86400 for background. http_check: default 15, maximum 120.' },
    url: { type: 'string', description: 'http_check: actual HTTP(S) URL, including loopback development endpoints.' },
    method: { type: 'string', enum: ['GET', 'HEAD'], default: 'GET' },
    expected_status: { type: 'integer', minimum: 100, maximum: 599, default: 200 },
    retry_interval_ms: { type: 'integer', minimum: 100, maximum: 5000, default: 300 }
  }, required: ['type']
};

export const workspaceTools = [
  { name: 'workspace_execute', title: 'Execute a durable workspace batch',
    description: 'Combine UTF-8 writes, exact unified patches, rootless container image builds, mkdir, foreground commands, background service starts and retried HTTP checks in one durable dependency graph. Defaults to sequential order; explicit depends_on and [] enable parallel work. Entire plan is validated before effects. Files/commands run as the existing execution user. Returns per-step states, outputs, errors and job IDs; long plans return an execution_id for workspace_read. Use a stable request_id when retrying identical calls to avoid duplicate effects. Writes require content. Mark long-lived servers background:true and verify readiness with http_check. No rollback or system-level autostart.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      steps: { type: 'array', minItems: 1, maxItems: 32, items: stepSchema },
      cwd: { type: 'string', default: '.', description: 'Project directory relative to workspace_root. Writes/mkdir can create a new project; exec requires its cwd to exist.' },
      request_id: { type: 'string', description: 'Optional stable 1..64 character identifier: letters, digits, underscore, hyphen. Same ID and plan reuse the execution; different plan is rejected.' },
      parallelism: { type: 'integer', minimum: 1, maximum: 4, default: 4 },
      stop_on_error: { type: 'boolean', default: true, description: 'Stop scheduling pending steps on failure; running independent steps finish. Dependents of failures are always skipped.' },
      cleanup_background_on_failure: { type: 'boolean', default: true, description: 'Cancel background jobs started by this batch if it fails. Cancellation always stops this batch\u0027s jobs.' },
      timeout_seconds: { type: 'integer', minimum: 1, maximum: 86400, default: 3600 },
      max_output_bytes: { type: 'integer', minimum: 256, maximum: 32768, default: 8192, description: 'Output retained per step in results; complete logs remain available via job_read.' },
      wait_ms: { type: 'integer', minimum: 0, maximum: 10000, default: 1000 }
    }, required: ['steps'] }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
  { name: 'workspace_read', title: 'Read batch progress and step results', description: 'Read durable batch states, step outputs/errors/job IDs and incremental coordinator logs. Reuse next_offset; wait_ms waits briefly for new progress. succeeded means finite steps passed; background service lifetime must be checked separately. No automatic ChatGPT wakeup.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { execution_id: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, max_bytes: { type: 'integer', minimum: 1, maximum: 262144 }, wait_ms: { type: 'integer', minimum: 0, maximum: 10000 } }, required: ['execution_id'] }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'workspace_list', title: 'Recover saved batch IDs', description: 'List saved executions and statuses after reconnecting or context loss. Inspect before resubmitting work.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'workspace_cancel', title: 'Cancel a batch and its jobs', description: 'Stop pending/running batch work and jobs started by this execution, including background services retained after successful completion. Does not undo writes. Poll workspace_read/job_read to confirm termination.',
    inputSchema: { type: 'object', properties: { execution_id: { type: 'string' } }, required: ['execution_id'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }
];
