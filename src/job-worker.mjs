import { Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { open, access, unlink, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { atomicJSON, executionCommand, readJSON } from './common.mjs';
import { TailBuffer } from './head-tail.mjs';

const dir = process.argv[2];
const stateFile = path.join(dir, 'state.json');
let child;
let stopped = false;
let stopReason;
let escalation;
let timeout;
let cancelMonitor;
let state;

let ttyServer;
const ttySocket = path.join(dir, 'tty.sock');
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
async function stopTTY() {
  if (!ttyServer) return;
  await new Promise(resolve => ttyServer.close(resolve));
  ttyServer = null;
  await unlink(ttySocket).catch(error => { if(error.code!=='ENOENT') throw error; });
}

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
    // Preserve the original append-only output.log cursor contract.
    // Retain a small rolling tail separately so final errors aren't lost.
    const tail=new TailBuffer(65536);
    const sink=new Writable({write(chunk, _encoding, callback) {
      const keep=Math.min(chunk.length,Math.max(0,cap-logged));
      dropped+=chunk.length-keep;logged+=keep;
      tail.push(chunk);
      if(!keep){callback();return;}
      (async()=>{let written=0;while(written<keep){const out=await log.write(chunk,written,keep-written);if(!out.bytesWritten)throw new Error('Log write made no progress');written+=out.bytesWritten;}})().then(()=>callback(),callback);
    }});
    sink.on('error',()=>{ requestStop('log write failed').catch(()=>{}); });
    if (spec.tty) {
      const seenInput=new Map();
      ttyServer=createServer({allowHalfOpen:true},socket=>{
        const pieces=[]; let size=0;
        socket.setTimeout(5000,()=>socket.destroy());
        socket.on('data',bytes=>{
          size+=bytes.length;
          if (size>8192) {socket.end('TOO_LARGE');return;}
          pieces.push(bytes);
        });
        socket.on('end',()=>{
          if (size>8192 || !child?.stdin?.writable || stopped) {socket.end('NOT_RUNNING');return;}
          let item;
          try {item=JSON.parse(Buffer.concat(pieces).toString('utf8'));}
          catch {socket.end('INVALID_JSON');return;}
          if (typeof item.chars!=='string' || !item.chars.length || Buffer.byteLength(item.chars)>4096) {
            socket.end('INVALID_INPUT');return;
          }
          const id=item.request_id;
          if (id!==undefined && (typeof id!=='string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id))) {
            socket.end('INVALID_ID');return;
          }
          const digest=createHash('sha256').update(item.chars).digest('hex');
          const previous=id===undefined ? undefined : seenInput.get(id);
          if (previous) {socket.end(previous===digest?'REUSED':'CONFLICT');return;}
          // Keep deduplication deterministic without unbounded memory growth
          // during long-lived REPL sessions. Refuse new IDs rather than evicting
          // old ones and accidentally replaying an ambiguous previous command.
          if(id!==undefined && seenInput.size>=4096){socket.end('INPUT_ID_LIMIT');return;}
          if (id!==undefined) seenInput.set(id,digest);
          try {child.stdin.write(item.chars,error=>{
            if(error && id!==undefined) seenInput.delete(id);
            socket.end(error?'FAILED':'OK');
          });}
          catch {
            if(id!==undefined) seenInput.delete(id);
            socket.end('FAILED');
          }
        });
        socket.on('error',()=>{});
      });
      await new Promise((resolve,reject)=>{
        ttyServer.once('error',reject);
        ttyServer.listen(ttySocket,()=>{
          ttyServer.off('error',reject);resolve();
        });
      });
      await chmod(ttySocket,0o600);
    }
    // script(1) owns the PTY; arguments are individually shell-quoted, so
    // callers cannot inject additional shell tokens through argv boundaries.
    const command=spec.tty ? ['/usr/bin/script','-qefc',spec.argv.map(shellQuote).join(' '),'/dev/null'] : spec.argv;
    const [executable, argv] = executionCommand(command, JOB_EXEC_UID !== undefined);
    child = spawn(executable, argv, { cwd: spec.cwd, env: { ...safeEnvironment, ...spec.env }, stdio: [(spec.tty || spec.stdin !== undefined) ? 'pipe' : 'ignore', 'pipe', 'pipe'],
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
      if (spec.tty) child.stdin.write(spec.stdin);
      else child.stdin.end(spec.stdin);
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
    // Only the retained head is available through the historic offset cursor.
    // Write tail before terminal state so readers never see incomplete preview.
    if (dropped) await writeFile(path.join(dir, 'output.tail'), tail.snapshot(), { mode: 0o600, flag: 'wx' });
    state.log_truncated=dropped>0; state.dropped_log_bytes=dropped;
    state.log_total_bytes=logged+dropped;
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
    await unlink(path.join(path.dirname(dir), 'active', path.basename(dir))).catch(e => { if(e.code!=='ENOENT')throw e; });
    await log.close();
    await stopTTY();
  }
  // Do not retain user-supplied environment secrets after execution.
  if (state && ['succeeded','failed','cancelled','interrupted'].includes(state.status))
    await unlink(path.join(path.dirname(dir), 'active', path.basename(dir))).catch(e => {if(e.code!=='ENOENT')throw e;});
  await unlink(path.join(dir, 'spec.json')).catch(() => {});
} catch (error) {
  clearInterval(cancelMonitor);
  await stopTTY().catch(() => {});
  if (state) {
    state.status = stopped ? 'cancelled' : 'failed';
    state.error = error.message;
    state.finished_at = new Date().toISOString();
    await atomicJSON(stateFile, state).catch(() => {});
  }
  process.exitCode = 1;
}
