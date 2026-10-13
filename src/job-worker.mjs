import { Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { open, access, unlink } from 'node:fs/promises';
import path from 'node:path';
import { atomicJSON, executionCommand, readJSON } from './common.mjs';

const dir = process.argv[2];
const stateFile = path.join(dir, 'state.json');
let child;
let stopped = false;
let stopReason;
let escalation;
let timeout;
let cancelMonitor;
let state;

async function requestStop(reason) {
  if (stopped) return;
  stopped = true;
  stopReason = reason;
  // Write cancellation before escalation; SIGKILL cannot execute cleanup hooks.
  if (state) {
    state.status = 'cancelled';
    state.reason = reason;
    state.finished_at = new Date().toISOString();
    await atomicJSON(stateFile, state);
  }
  if (child) {
    // The worker leads a dedicated process group. SIGTERM reaches descendants too.
    try { process.kill(-process.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    escalation = setTimeout(() => {
      try { process.kill(-process.pid, 'SIGKILL'); } catch {}
    }, 2000);
  }
}

process.on('SIGTERM', () => { requestStop('cancelled by user').catch(() => process.exit(1)); });
process.on('SIGINT', () => { requestStop('interrupted').catch(() => process.exit(1)); });

try {
  const spec = await readJSON(path.join(dir, 'spec.json'));
  state = await readJSON(stateFile);
  try { await access(path.join(dir, 'cancel')); stopped = true; stopReason = 'cancelled before launch'; } catch {}
  if (stopped) {
    state.status = 'cancelled';
    state.reason = stopReason;
    state.finished_at = new Date().toISOString();
    await atomicJSON(stateFile, state);
  } else {
    const log = await open(path.join(dir, 'output.log'), 'a', 0o600);
    const { JOB_EXEC_UID, JOB_EXEC_GID, ...safeEnvironment } = process.env;
    let logged=0, dropped=0;
    const cap=spec.max_log_bytes || 16*1024*1024;
    const sink=new Writable({write(chunk, _encoding, callback) {
      const keep=Math.min(chunk.length,Math.max(0,cap-logged));
      dropped+=chunk.length-keep;logged+=keep;
      if(!keep){callback();return;}
      (async()=>{let written=0;while(written<keep){const out=await log.write(chunk,written,keep-written);if(!out.bytesWritten)throw new Error('Log write made no progress');written+=out.bytesWritten;}})().then(()=>callback(),callback);
    }});
    sink.on('error',()=>{ requestStop('log write failed').catch(()=>{}); });
    const [executable, argv] = executionCommand(spec.argv, JOB_EXEC_UID !== undefined);
    child = spawn(executable, argv, { cwd: spec.cwd, env: { ...safeEnvironment, ...spec.env }, stdio: [spec.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      ...(JOB_EXEC_UID !== undefined ? { uid: Number(JOB_EXEC_UID), gid: Number(JOB_EXEC_GID) } : {}) });
    // Attach completion handlers immediately, including command-not-found errors.
    const finished = new Promise(resolve => {
      child.once('error', error => resolve({ error: error.message, code: null, signal: null }));
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    child.stdout.pipe(sink,{end:false});
    child.stderr.pipe(sink,{end:false});
    if (spec.stdin !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(spec.stdin);
    }
    state.status = stopped ? 'cancelled' : 'running';
    state.started_at = new Date().toISOString();
    state.command_pid = child.pid ?? null;
    state.worker_pid = process.pid;
    await atomicJSON(stateFile, state);
    cancelMonitor = setInterval(() => {
      access(path.join(dir, 'cancel')).then(() => requestStop('cancelled by user')).catch(() => {});
    }, 100);
    if (stopped) {
      try { process.kill(-process.pid, 'SIGTERM'); } catch {}
    }
    timeout = setTimeout(() => { requestStop('timeout').catch(() => process.exit(1)); }, spec.timeout_seconds * 1000);
    const result = await finished;
    await new Promise(resolve=>sink.end(resolve));
    state.log_truncated=dropped>0; state.dropped_log_bytes=dropped;
    clearInterval(cancelMonitor);
    clearTimeout(timeout);
    // Keep escalation alive after the direct child exits: its descendants may
    // ignore SIGTERM and still hold resources. The terminal state is saved first.
    if (!stopped) clearTimeout(escalation);
    state.status = stopped ? 'cancelled' : (result.code === 0 ? 'succeeded' : 'failed');
    state.exit_code = result.code;
    state.signal = result.signal;
    if (result.error) state.error = result.error;
    if (stopReason) state.reason = stopReason;
    state.finished_at = new Date().toISOString();
    await atomicJSON(stateFile, state);
    await log.close();
  }
  // Do not retain user-supplied environment secrets after execution.
  await unlink(path.join(dir, 'spec.json')).catch(() => {});
} catch (error) {
  clearInterval(cancelMonitor);
  if (state) {
    state.status = stopped ? 'cancelled' : 'failed';
    state.error = error.message;
    state.finished_at = new Date().toISOString();
    await atomicJSON(stateFile, state).catch(() => {});
  }
  process.exitCode = 1;
}
