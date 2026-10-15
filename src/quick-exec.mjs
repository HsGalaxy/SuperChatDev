// Short-lived, non-durable command execution for low-latency developer queries.
// This is intentionally NOT a second durable Jobs implementation: no saved logs,
// request replay, PTY or recovery. Side-effecting commands belong in job_start.
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { isInside, requireInteger, scopedPath, executionCommand } from './common.mjs';
import { executionEnvironment } from './environment.mjs';
import { headUtf8, tailUtf8, TailBuffer } from './head-tail.mjs';

const defaultTimeout = 10000;
const defaultOutput = 16384;

export class QuickExec {
  constructor({ workspace, dataRoot, executionUid, executionGid, executionHome, executionEnv, maxJobs = 4 }) {
    Object.assign(this, { workspace, dataRoot, executionUid, executionGid, executionHome, executionEnv });
    // Separate small admission budget: these commands are not durable Jobs.
    this.capacity = Math.min(2, Math.max(1, maxJobs));
    this.running = 0;
  }

  async run({ command, argv, cwd = '.', timeout_ms, max_output_bytes } = {}, configuredLimit = this.capacity) {
    if (process.platform !== 'linux') throw new Error('Quick exec currently requires Linux');
    if ((command === undefined) === (argv === undefined))
      throw new Error('Provide exactly one of command or argv');
    if (command !== undefined) {
      if (typeof command !== 'string' || !command.trim() || command.includes('\0') ||
          Buffer.byteLength(command) > 16384)
        throw new Error('command must be a nonempty shell string within 16 KiB');
      argv = ['bash', '--noprofile', '--norc', '-c', command];
    } else if (!Array.isArray(argv) || !argv.length || argv.length > 128 ||
               argv.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !argv[0] ||
               Buffer.byteLength(JSON.stringify(argv)) > 32768) {
      throw new Error('argv must be an array of 1..128 nonempty-executable strings within 32 KiB');
    }
    const timeout = requireInteger(timeout_ms, defaultTimeout, 100, 30000, 'timeout_ms');
    const maxBytes = requireInteger(max_output_bytes, defaultOutput, 256, 65536, 'max_output_bytes');
    const directory = await scopedPath(this.workspace, cwd);
    if (this.dataRoot && isInside(this.dataRoot, directory))
      throw new Error('Quick exec cannot use the private MCP state directory as cwd');
    if (process.geteuid?.() === 0 && this.executionUid === undefined)
      throw new Error('Quick exec refuses to run with root privileges; configure an unprivileged execution identity');
    if (this.executionUid !== undefined && !Number.isSafeInteger(this.executionGid))
      throw new Error('Quick exec needs both executionUid and executionGid');
    const maximum = Math.min(this.capacity, Math.max(1, configuredLimit));
    if (this.running >= maximum)
      throw new Error('Quick exec concurrency limit reached; use job_start for tracked work');
    this.running++;
    const started = performance.now();
    try {
      const [binary, arguments_] = executionCommand(argv, this.executionUid !== undefined);
      const child = spawn(binary, arguments_, {
        cwd: directory,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: executionEnvironment(this),
        ...(this.executionUid !== undefined ?
          { uid: this.executionUid, gid: this.executionGid } : {})
      });
      // Only a fixed amount is retained, regardless of command output size.
      const first = Buffer.alloc(maxBytes);
      const tail = new TailBuffer(Math.ceil(maxBytes / 2));
      let held = 0, total = 0, spawnError = null;
      let timedOut = false, overProduced = false, escalator;
      const signalGroup = signal => {
        if (!child.pid) return;
        try { process.kill(-child.pid, signal); }
        catch (error) { if (error.code !== 'ESRCH') spawnError ??= error.message; }
      };
      const stopGroup = () => {
        signalGroup('SIGTERM');
        if (!escalator) {
          escalator = setTimeout(() => signalGroup('SIGKILL'), 500);
          escalator.unref();
        }
      };
      const collect = chunk => {
        total += chunk.length;
        const n = Math.min(chunk.length, maxBytes - held);
        if (n > 0) { chunk.copy(first, held, 0, n); held += n; }
        tail.push(chunk);
        // This is an interactive developer convenience, not a streaming log
        // sink. Stop pathological output after 8 MiB rather than burning CPU.
        if (total > 8 * 1024 * 1024 && !overProduced) {
          overProduced = true;
          stopGroup();
        }
      };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      const outcome = await new Promise(resolve => {
        const watchdog = setTimeout(() => {
          timedOut = true;
          stopGroup();
        }, timeout);
        child.once('error', error => { spawnError = error.message; });
        child.once('close', (exit_code, signal) => {
          clearTimeout(watchdog);
          if (!timedOut) clearTimeout(escalator);
          resolve({ exit_code, signal });
        });
      });
      let omitted = 0;
      let output;
      if (total <= maxBytes) {
        output = headUtf8(first.subarray(0, held));
      } else {
        const head = headUtf8(first.subarray(0, Math.floor(maxBytes / 2)));
        const ending = tailUtf8(tail.snapshot());
        omitted = Math.max(0, total - Buffer.byteLength(head) - Buffer.byteLength(ending));
        output = head + '\n... ' + omitted + ' bytes omitted ...\n' + ending;
      }
      const status = timedOut ? 'timeout' : overProduced ? 'output_limit' : outcome.exit_code === 0 ? 'succeeded' : 'failed';
      return {
        status, exit_code: spawnError ? null : outcome.exit_code, signal: outcome.signal, timed_out: timedOut,
        output_limit_reached: overProduced,
        output, output_bytes: total, output_truncated: total > maxBytes,
        omitted_bytes: omitted, duration_ms: Math.round((performance.now() - started) * 100) / 100,
        ephemeral: true,
        ...(spawnError ? { error: spawnError } : {}),
        next_step: 'This command has no persisted Job ID or replay protection. Inspect exit_code. For writes, long commands, PTY, resumability or reliable retries use job_start with a request_id.'
      };
    } finally {
      this.running--;
    }
  }
}

export const quickExecTool = {
  name: 'exec', title: 'Run one quick development command',
  description: 'Low-latency one-shot command for brief preferably read-only queries (pwd, git status, rg). Returns output, exit_code and timeout in a single call, without a Job ID, persisted logs, retry deduplication, or PTY. Prefer argv; command runs explicitly via clean Bash. 30-second timeout and 8 MiB total-output execution cap. For any non-idempotent effect, lengthy build/test, recoverable process or interactive shell use job_start and request_id instead. Execution follows the same workspace, identity, environment and admin permissions as job_start.',
  inputSchema: {
    type: 'object', additionalProperties: false, properties: {
      argv: {type: 'array', minItems: 1, maxItems: 128, items: {type: 'string'}, description: 'Executable followed by arguments; no implicit shell'},
      command: {type: 'string', description: 'Explicit Bash snippet instead of argv'},
      cwd: {type: 'string', default: '.', description: 'Existing workspace-relative directory'},
      timeout_ms: {type: 'integer', minimum: 100, maximum: 30000, default: defaultTimeout},
      max_output_bytes: {type: 'integer', minimum: 256, maximum: 65536, default: defaultOutput}
    }
  },
  annotations: {readOnlyHint: false, destructiveHint: true, openWorldHint: true}
};
