import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, writeFile, unlink, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJSON, readJSON, requireInteger, scopedPath } from './common.mjs';

import { executionEnvironment } from './environment.mjs';
import { currentTrace } from './trace.mjs';
import { headUtf8, tailUtf8 } from './head-tail.mjs';

const workerPath = fileURLToPath(new URL('./job-worker.mjs', import.meta.url));
const terminalStates = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const validID = /^[0-9a-f-]{36}$/;

export async function processIdentity(pid) {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z') return null;
    return fields[19]; // Linux /proc field 22, starttime: prevents PID-reuse mistakes.
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
    throw error;
  }
}

export class Jobs {
  constructor({ workspace, dataRoot, maxJobs = 4, maxJobLogBytes = 16 * 1024 * 1024, executionUid, executionGid, executionHome, executionEnv }) {
    this.workspace = workspace;
    this.root = path.join(dataRoot, 'jobs');
    this.activeDir = path.join(this.root, 'active');
    this.maxJobs = maxJobs;
    this.maxJobLogBytes = maxJobLogBytes;
    this.settingsFile = path.join(dataRoot, 'admin-settings.json');
    Object.assign(this, { executionUid, executionGid, executionHome, executionEnv });
    this.launchQueue = Promise.resolve();
  }

  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(this.activeDir, { recursive: true, mode: 0o700 });
    // One-time compatibility migration for installations with historical jobs.
    // Concurrent initializers are harmless: individual marker creation is
    // exclusive, and both resolve status from durable state.json.
    const ready = path.join(this.activeDir, '.ready');
    try { await readFile(ready); return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const ids = (await readdir(this.root)).filter(id => validID.test(id));
    for (const id of ids) {
      const state = await this.status(id);
      if (!terminalStates.has(state.status)) {
        try { await writeFile(path.join(this.activeDir, id), '', {flag:'wx',mode:0o600}); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
    }
    try { await writeFile(ready, '1', {flag:'wx',mode:0o600}); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }

  async active() {
    // Admission is called under the cross-process flock. Stale entries are
    // reaped by status(), including workers killed before they could clean up.
    const ids = (await readdir(this.activeDir)).filter(id => validID.test(id));
    const states=[];
    for (const id of ids) {
      try {
        const current=await this.status(id);
        if (!terminalStates.has(current.status)) states.push(current);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await unlink(path.join(this.activeDir,id)).catch(e => {if(e.code!=='ENOENT')throw e;});
      }
    }
    return states;
  }

  directory(id) {
    if (!validID.test(id ?? '')) throw new Error('Invalid job ID');
    return path.join(this.root, id);
  }

  async status(id) {
    const dir = this.directory(id);
    const state = await readJSON(path.join(dir, 'state.json'));
    if (terminalStates.has(state.status)) {
      await unlink(path.join(this.activeDir,id)).catch(e => { if(e.code!=='ENOENT') throw e; });
      return state;
    }
    let owner;
    try { owner = await readJSON(path.join(dir, 'owner.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!terminalStates.has(state.status) && !owner && Date.now() - Date.parse(state.created_at) > 30000) {
      const wasCancelled = await readFile(path.join(dir, 'cancel')).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; });
      state.status = wasCancelled ? 'cancelled' : 'interrupted';
      state.finished_at = new Date().toISOString();
      state.error = wasCancelled ? 'Cancelled before worker launch completed' : 'Worker launch was not recorded';
      await atomicJSON(path.join(dir, 'state.json'), state);
      await unlink(path.join(this.activeDir,id)).catch(e => {if(e.code!=='ENOENT')throw e;});
      return state;
    }
    if (!terminalStates.has(state.status) && owner) {
      const identity = await processIdentity(owner.pid);
      if (!identity || identity !== owner.starttime) {
        // Only the worker writes live state; reconciliation occurs after it has exited.
        const latest = await readJSON(path.join(dir, 'state.json'));
        if (!terminalStates.has(latest.status)) {
          const wasCancelled = await readFile(path.join(dir, 'cancel')).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; });
          latest.status = wasCancelled ? 'cancelled' : 'interrupted';
          latest.finished_at = new Date().toISOString();
          latest.error = wasCancelled ? 'Worker exited following cancellation' : 'Worker exited without recording a terminal state';
          await atomicJSON(path.join(dir, 'state.json'), latest);
        }
        if (terminalStates.has(latest.status))
          await unlink(path.join(this.activeDir,id)).catch(e => {if(e.code!=='ENOENT')throw e;});
        return latest;
      }
    }
    return state;
  }

  async list() {
    const ids = (await readdir(this.root)).filter(id => validID.test(id));
    const states = await Promise.all(ids.map(id => this.status(id)));
    return states.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async start(input) {
    const args = { ...input };
    // Fast path: a short foreground command typically finishes within 500ms.
    // A longer process is still a durable job and returns its job_id.
    const wait = requireInteger(args.wait_ms, 500, 0, 10000, 'wait_ms');
    const maxBytes = requireInteger(args.max_bytes, 16384, 256, 65536, 'max_bytes');
    delete args.wait_ms; delete args.max_bytes;
    if (args.command !== undefined) {
      if (args.argv !== undefined || typeof args.command !== 'string' || !args.command) throw new Error('Provide exactly one of argv or command');
      args.argv = ['bash', '--noprofile', '--norc', '-c', args.command]; delete args.command;
    }
    const request = args.request_id; delete args.request_id;
    if (request !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(request)) throw new Error('request_id must be 1..64 letters, digits, underscores or hyphens');
    const pending = this.launchQueue.then(() => this.withAdmissionLock(async () => {
      if (!request) return this.startInternal(args);
      // Keep a reservation BEFORE spawning. An ambiguous crash never replays writes.
      const key = path.join(this.root, 'requests', request + '.json');
      const hash = createHash('sha256').update(JSON.stringify({argv:args.argv,cwd:args.cwd ?? '.',env:Object.fromEntries(Object.entries(args.env || {}).sort()),timeout_seconds:args.timeout_seconds ?? 3600,stdin:args.stdin,tty:args.tty===true})).digest('hex');
      let previous;
      try { previous = await readJSON(key); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (previous) {
        if (previous.hash !== hash) throw new Error('request_id already belongs to different arguments; choose a new ID');
        try { return { ...await this.status(previous.id), reused: true }; }
        catch (e) { if (e.code !== 'ENOENT') throw e; throw new Error('Request reservation exists but job state is missing. Do not resubmit blindly; inspect job_list and the request reservation: ' + previous.id); }
      }
      const id = randomUUID();
      await atomicJSON(key, {id, hash});
      return this.startInternal({...args, reserved_id:id, request_id:request});
    }));
    this.launchQueue = pending.catch(() => {});
    const job = await pending;
    if (!wait) return job;
    const deadline = Date.now() + wait;
    let result;
    do {
      result = await this.readOnce({job_id:job.id, max_bytes:maxBytes});
      if (terminalStates.has(result.status) || Date.now() >= deadline) break;
      // Poll more frequently than the old 100ms granularity for short commands;
      // never wait out the remaining budget after a terminal result.
      await delay(Math.min(35, Math.max(1, deadline - Date.now())));
    } while (true);
    return {...result, ...(job.reused ? {reused:true} : {})};
  }

  async page({limit=50,cursor, status, cwd} = {}) {
    requireInteger(limit,50,1,200,'limit');
    let all=await this.list();
    if(status !== undefined && !['active',...terminalStates].includes(status))throw new Error('Invalid status filter');
    if(status)all=all.filter(j=>status==='active'?!terminalStates.has(j.status):j.status===status);
    if(cwd)all=all.filter(j=>j.cwd===cwd);
    const index=cursor ? all.findIndex(j=>j.id===cursor)+1 : 0;
    if(cursor && !index)throw new Error('Unknown pagination cursor; refresh job_list');
    const page=all.slice(index,index+limit);
    return {jobs:page.map(compactJob),total:all.length,next_cursor:index+page.length<all.length?page.at(-1).id:null};
  }

  async withAdmissionLock(operation) {
    // Batch coordinators and the HTTP server share one admission limit. flock
    // releases automatically even if a coordinator crashes during admission.
    const lock = spawn('/usr/bin/flock', ['-x', path.join(this.root, '.admission.lock'), process.execPath, '-e',
      'process.stdout.write("locked\\n"); process.stdin.resume(); process.stdin.on("end",()=>process.exit(0))'], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH }
    });
    lock.stdin.on('error', () => {});
    const closed = new Promise(resolve => { lock.once('close', resolve); lock.once('error', () => resolve()); });
    try {
      await new Promise((resolve, reject) => {
        lock.once('error', reject);
        lock.once('exit', () => reject(new Error('Job admission lock exited before acquisition')));
        lock.stdout.once('data', resolve);
      });
      return await operation();
    } finally { lock.stdin.end(); await closed; }
  }

  async startInternal({ argv, cwd = '.', env = {}, timeout_seconds, stdin, tty = false, batch_execution_id, batch_step_id, job_kind, reserved_id, request_id, trace_id = currentTrace() }) {
    if (process.platform !== 'linux') throw new Error('Durable jobs currently require Linux');
    if (!Array.isArray(argv) || argv.length === 0 || argv.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('argv must be a nonempty array of strings');
    if (!argv[0]) throw new Error('argv[0] cannot be empty');
    if (typeof tty !== 'boolean') throw new Error('tty must be a boolean');
    if (tty) await access('/usr/bin/script'); // util-linux optional dependency

    if (!env || Array.isArray(env) || typeof env !== 'object' || Object.entries(env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0'))) throw new Error('env must contain string environment variables');
    if (stdin !== undefined && (typeof stdin !== 'string' || Buffer.byteLength(stdin) > 1024 * 1024)) throw new Error('Job stdin must be a string within 1 MiB');
    const timeout = requireInteger(timeout_seconds, 3600, 1, 86400, 'timeout_seconds');
    const helper = job_kind === 'workspace_helper';
    // All coordinators read the same trusted admission setting while holding flock.
    let maxJobs=this.maxJobs, maxLogBytes=this.maxJobLogBytes;
    try {
      const settings=(await readJSON(this.settingsFile)).settings;
      if(Number.isSafeInteger(settings?.limits?.maxJobs))maxJobs=settings.limits.maxJobs;
      if(Number.isSafeInteger(settings?.limits?.maxJobLogMB))maxLogBytes=settings.limits.maxJobLogMB*1024*1024;
    } catch(e) { if(e.code!=='ENOENT')throw e; }
    const active = (await this.active()).filter(state => (state.job_kind === 'workspace_helper') === helper);
    if (active.length >= (helper ? 4 : maxJobs)) throw new Error('Concurrent job limit reached');
    const directory = await scopedPath(this.workspace, cwd);
    const id = reserved_id || randomUUID();
    const dir = this.directory(id);
    await mkdir(dir, { mode: 0o700 });
    const created = new Date().toISOString();
    const metadata = { ...(request_id ? {request_id} : {}), ...(trace_id ? { trace_id } : {}), ...(batch_execution_id ? { batch_execution_id, batch_step_id } : {}), ...(helper ? { job_kind } : {}), ...(tty ? {tty:true} : {}) };
    await atomicJSON(path.join(dir, 'spec.json'), { argv, cwd: directory, env, timeout_seconds: timeout, stdin, tty, max_log_bytes:maxLogBytes });
    await atomicJSON(path.join(dir, 'state.json'), { id, argv, cwd, status: 'queued', created_at: created, exit_code: null, ...metadata });
    await writeFile(path.join(this.activeDir,id), '', {flag:'wx',mode:0o600});
    const worker = spawn(process.execPath, [workerPath, dir], {
      detached: true,
      stdio: 'ignore',
      // Do not leak MCP/OAuth/download credentials into shell jobs.
      env: { ...executionEnvironment(this),
        ...(this.executionUid !== undefined ? { JOB_EXEC_UID: String(this.executionUid), JOB_EXEC_GID: String(this.executionGid) } : {}) }
    });
    try {
      await new Promise((resolve, reject) => { worker.once('spawn', resolve); worker.once('error', reject); });
    } catch (error) {
      await atomicJSON(path.join(dir, 'state.json'), { id, argv, cwd, status: 'failed', created_at: created, finished_at: new Date().toISOString(), exit_code: null, error: error.message, ...metadata });
      await unlink(path.join(this.activeDir,id)).catch(e => {if(e.code!=='ENOENT')throw e;});
      throw error;
    }
    const starttime = await processIdentity(worker.pid);
    await atomicJSON(path.join(dir, 'owner.json'), { pid: worker.pid, starttime });
    worker.unref();
    return this.status(id);
  }

  async read(args) {
    const wait = requireInteger(args.wait_ms, 0, 0, 10000, 'wait_ms');
    const deadline = Date.now() + wait;
    let result;
    do {
      result = await this.readOnce(args);
      if (result.output || terminalStates.has(result.status) || Date.now() >= deadline) return result;
      await delay(Math.min(200, Math.max(1, deadline - Date.now())));
    } while (true);
  }

  async readOnce({ job_id, offset = 0, max_bytes }) {
    const position = requireInteger(offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
    const limit = requireInteger(max_bytes, 32768, 1, 262144, 'max_bytes');
    const state = await this.status(job_id);
    let file;
    try { file = await open(path.join(this.directory(job_id), 'output.log'), 'r'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return { ...state, output: '', next_offset: position, has_more: false }; }
    try {
      const buffer = Buffer.alloc(limit + 3);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      const { size } = await file.stat();
      let end = Math.min(limit, bytesRead);
      while (end < bytesRead && (buffer[end] & 0xc0) === 0x80) end++;
      if (!terminalStates.has(state.status) && end === bytesRead && end) {
        let begin=end-1; while(begin>0 && (buffer[begin]&0xc0)===0x80)begin--;
        const byte=buffer[begin], needed=byte>=0xf0?4:byte>=0xe0?3:byte>=0xc0?2:1;
        if(begin+needed>end)end=begin;
      }
      const result = { ...state, output: buffer.subarray(0, end).toString('utf8'), next_offset: position + end, has_more: size > position + end, log_bytes: size };
      const total = state.log_total_bytes ?? (size + (state.dropped_log_bytes ?? 0));
      if (terminalStates.has(state.status) && total > limit) {
        // The additional preview does not affect next_offset and pagination.
        const budget = Math.min(limit, 32768);
        const headBudget = Math.floor(budget / 2);
        const tailBudget = budget - headBudget;
        const head = Buffer.alloc(headBudget);
        const start = await file.read(head, 0, headBudget, 0);
        let tail;
        if (state.log_truncated) {
          try {
            const tailFile = await open(path.join(this.directory(job_id), 'output.tail'), 'r');
            try {
              const tailSize = (await tailFile.stat()).size;
              const count = Math.min(tailBudget, tailSize);
              const buf = Buffer.alloc(count);
              const read = await tailFile.read(buf, 0, count, tailSize - count);
              tail = buf.subarray(0, read.bytesRead);
            } finally { await tailFile.close(); }
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        } else {
          const count = Math.min(tailBudget, size);
          const buf = Buffer.alloc(count);
          const read = await file.read(buf, 0, count, size - count);
          tail = buf.subarray(0, read.bytesRead);
        }
        if (tail) {
          const beginning = headUtf8(head.subarray(0, start.bytesRead));
          const ending = tailUtf8(tail);
          const preserved = Buffer.byteLength(beginning) + Buffer.byteLength(ending);
          const omitted = Math.max(0, total - preserved);
          result.output_preview = beginning + '\n... ' + omitted + ' bytes omitted ...\n' + ending;
          result.preview_omitted_bytes = omitted;
        } else {
          result.preview_tail_unavailable = true;
        }
      }
      return result;
    } finally { await file.close(); }
  }

  async input({ job_id, chars, offset, max_bytes, wait_ms = 250, request_id } = {}) {
    const state=await this.status(job_id);
    if (!state.tty) throw new Error('Job does not have a PTY; start it with tty:true');
    if (terminalStates.has(state.status)) throw new Error('PTY job already finished');
    if (typeof chars !== 'string' || !chars.length || Buffer.byteLength(chars)>4096)
      throw new Error('chars must be a nonempty UTF-8 string, maximum 4 KiB');
    requireInteger(wait_ms, 250, 0, 10000, 'wait_ms');
    if (request_id !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(request_id))
      throw new Error('request_id must be 1..64 letters, digits, underscores or hyphens');
    const after = offset ?? 0;
    const socketPath=path.join(this.directory(job_id),'tty.sock');
    const acknowledgement=await new Promise((resolve,reject)=>{
      const socket=connect(socketPath);
      let response='';
      const timer=setTimeout(()=>socket.destroy(new Error('PTY input timeout')),5000);
      socket.once('connect',()=>socket.end(JSON.stringify({chars,request_id}),'utf8'));
      socket.on('data',data=>{
        response+=data.toString('utf8');
        if (response.length>128) socket.destroy(new Error('Unexpected PTY acknowledgement'));
      });
      socket.once('error',error=>{clearTimeout(timer);reject(error);});
      socket.once('end',()=>{clearTimeout(timer);resolve(response);});
      socket.once('close',()=>clearTimeout(timer));
    });
    if (!['OK','REUSED'].includes(acknowledgement)) throw new Error('PTY rejected input: '+acknowledgement);
    // Default to the start so the opening PTY prompt is not silently lost.
    // Pass the previous next_offset to avoid repeated output.
    const result=await this.read({job_id,offset:after,max_bytes,wait_ms});
    return {...result,input_accepted:true,input_reused:acknowledgement==='REUSED',input_bytes:Buffer.byteLength(chars)};
  }

  async cancel({ job_id }) {
    const state = await this.status(job_id);
    if (terminalStates.has(state.status)) return state;
    const dir = this.directory(job_id);
    await writeFile(path.join(dir, 'cancel'), '', { mode: 0o600 });
    let owner;
    try { owner = await readJSON(path.join(dir, 'owner.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const latest = await readJSON(path.join(dir, 'state.json'));
    if (latest.started_at && owner?.starttime && await processIdentity(owner.pid) === owner.starttime) {
      try { process.kill(-owner.pid, 'SIGTERM'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    const deadline = Date.now() + 400;
    let current;
    do {
      current = await this.status(job_id);
      if (terminalStates.has(current.status) || Date.now() >= deadline) break;
      await delay(Math.min(25, Math.max(1, deadline - Date.now())));
    } while (true);
    return { ...current, cancellation_requested: true };
  }
}

export function compactJob(job, includeCommand=false) {
  const {argv,...data}=job;
  return {...data,...(argv ? (includeCommand?{argv}:{executable:argv[0],argument_count:argv.length-1}) : {})};
}

export const jobTools = [
  {
    name: 'job_start', title: 'Start a durable development job',
    description: 'Preferred single-command execution. Optional tty:true uses util-linux script and requires interactive/legacy profile for job_input.  Default wait_ms=500: completed foreground commands return status, exit_code and output in one call; longer commands return their durable job_id for job_read. Set wait_ms=0 for long/background jobs when immediate control is needed. Use request_id for safe retries. command is an explicit clean Bash string, or supply argv. Run argv in a workspace directory. Returns promptly with a job ID. The independent worker keeps running across MCP HTTP-server restarts. Poll job_read until terminal status; this does not automatically wake ChatGPT. For shell syntax explicitly use ["bash", "--noprofile", "--norc", "-c", "..."] . stdin is closed for ordinary commands; tty:true uses an optional PTY with interactive/legacy profile and job_input. Large terminal logs include output_preview without changing pagination.',
    inputSchema: { type: 'object', properties: { command: {type:'string'}, request_id: {type:'string'}, tty: {type:'boolean',description:'Allocate a real PTY via util-linux script; job_input is enabled only under interactive/legacy tool profile.'}, wait_ms: {type:'integer',minimum:0,maximum:10000}, max_bytes: {type:'integer',minimum:256,maximum:65536}, argv: { type: 'array', minItems: 1, items: { type: 'string' } }, cwd: { type: 'string', default: '.' }, env: { type: 'object', additionalProperties: { type: 'string' } }, timeout_seconds: { type: 'integer', minimum: 1, maximum: 86400 } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
  },
  {
    name: 'job_read', title: 'Read job status and incremental logs',
    description: 'Read durable status and a bounded log chunk; on terminal long jobs output_preview retains head and tail, even past the log cap. (up to 3 extra bytes to keep UTF-8 intact). Command arguments are omitted unless include_command is true. Reuse next_offset as offset. While queued/running set wait_ms=1000..10000 to wait briefly for output or completion instead of busy polling. Terminal states: succeeded, failed, cancelled, interrupted. Check exit_code and drain logs while has_more is true; empty output does not mean success. Logs are stdout and stderr combined.',
    inputSchema: { type: 'object', properties: { include_command: {type:'boolean'}, job_id: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, max_bytes: { type: 'integer', minimum: 1, maximum: 262144 }, wait_ms: { type: 'integer', minimum: 0, maximum: 10000 } }, required: ['job_id'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  {
    name: 'job_input', title: 'Send text to an interactive PTY job',
    description: 'Opt-in interactive/legacy profile only. Send UTF-8 chars to a tty:true job (include \\n for Enter or \\u0003 for Ctrl+C); poll subsequent output without rebuilding the process. Never send secrets unless you control terminal echo. PTY input is not persisted after the job finishes.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      job_id: {type:'string'}, chars: {type:'string',minLength:1,maxLength:4096},
      request_id: {type:'string',description:'Optional stable action ID. Identical retries are acknowledged without retyping into the PTY.'},
      offset: {type:'integer',minimum:0}, max_bytes:{type:'integer',minimum:1,maximum:262144},
      wait_ms:{type:'integer',minimum:0,maximum:10000,default:250}
    }, required:['job_id','chars'] },
    annotations: {readOnlyHint:false,destructiveHint:true,openWorldHint:true}
  },
  { name: 'job_list', title: 'List persisted development jobs', description: 'List job states, including jobs from previous HTTP-server sessions.', inputSchema: { type: 'object', properties: {limit:{type:'integer',minimum:1,maximum:200},cursor:{type:'string'},status:{type:'string',enum:['active','succeeded','failed','cancelled','interrupted']},cwd:{type:'string'}}, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'job_cancel', title: 'Cancel a development job', description: 'Request cancellation of the worker and its process group, escalating after a grace period. Poll job_read to confirm completion.', inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }
];
