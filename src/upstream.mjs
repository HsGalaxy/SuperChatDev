import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { executionEnvironment } from './environment.mjs';
import { executionCommand } from './common.mjs';

// MCP stdio uses newline-delimited JSON. Descriptors/results are forwarded intact,
// including _meta, annotations, resource links and structuredContent.
export class StdioUpstream {
  constructor(argv, { timeoutMs = 120000, spawnProcess = spawn, executionUid, executionGid, executionHome, executionEnv, workspace } = {}) {
    if (!Array.isArray(argv) || !argv.length || argv.some(value => typeof value !== 'string')) throw new Error('DESKTOP_COMMANDER_COMMAND must be a JSON argv array');
    this.argv = argv;
    this.timeoutMs = timeoutMs;
    this.spawnProcess = spawnProcess;
    this.isolated = executionUid !== undefined;
    this.spawnOptions = { cwd: workspace, env: { ...executionEnvironment({ executionHome, executionEnv }),
      DESKTOP_COMMANDER_DISABLE_TELEMETRY: 'true' }, ...(executionUid !== undefined ? { uid: executionUid, gid: executionGid } : {}) };
    this.pending = new Map();
    this.sequence = 0;
  }

  async init() {
    const [executable, argv] = executionCommand(this.argv, this.isolated);
    this.process = this.spawnProcess(executable, argv, { ...this.spawnOptions, stdio: ['pipe', 'pipe', 'inherit'] });
    this.process.stdin.on('error', failInput => {
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(failInput); }
      this.pending.clear();
      this.failure = failInput;
    });
    const fail = error => {
      this.failure = error;
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
      this.pending.clear();
    };
    this.process.on('error', fail);
    this.process.on('exit', () => fail(new Error('Desktop Commander process exited; restart the HTTP service to reconnect')));
    const lines = createInterface({ input: this.process.stdout });
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== undefined && message.method) {
        // This bridge does not implement upstream client-side sampling/elicitation.
        this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client-side requests are not supported by this bridge' } });
      } else if (message.id !== undefined) {
        const request = this.pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
      }
    });
    this.info = await this.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'chatgpt-dev-mcp', version: '0.1.0' } });
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  send(message) {
    if (this.failure) throw this.failure;
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}) {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        try { this.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'Bridge request timeout' } }); } catch {}
        reject(new Error('Desktop Commander request timed out'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  async listAll(method, key) {
    const items = [];
    let cursor;
    const seen = new Set();
    do {
      const result = await this.request(method, cursor ? { cursor } : {});
      items.push(...(result[key] || []));
      cursor = result.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error('Upstream returned a repeated pagination cursor');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return items;
  }

  close() {
    this.failure ??= new Error('Upstream closed');
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(this.failure); }
    this.pending.clear();
    this.process?.kill('SIGTERM');
  }
}
