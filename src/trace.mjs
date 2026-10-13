import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { atomicJSON, readJSON } from './common.mjs';

const context = new AsyncLocalStorage();
export const currentTrace = () => context.getStore();
const validID = /^[a-f0-9-]{36}$/;

export class Traces {
  constructor(dataRoot) { this.root = path.join(dataRoot, 'traces'); this.completed = 0; this.maxRecords = 5000; }
  async init() { await mkdir(this.root, { recursive: true, mode: 0o700 }); }
  async prune() {
    const files = (await readdir(this.root)).filter(name => /^\d+-[a-f0-9-]{36}\.json$/.test(name)).sort();
    await Promise.all(files.slice(0, Math.max(0, files.length - this.maxRecords)).map(name => rm(path.join(this.root, name), { force: true })));
  }
  async call(name, origin, operation) {
    const trace_id = randomUUID(), start = Date.now();
    // Never store arguments, command strings, output, environment, URLs or error text.
    const record = { trace_id, tool: name, origin, started_at: new Date(start).toISOString(), status: 'running' };
    const filename = path.join(this.root, `${start}-${trace_id}.json`);
    await atomicJSON(filename, record);
    let result;
    try {
      result = await context.run(trace_id, operation);
      record.status = result.isError ? 'error' : 'succeeded';
      const data = result.structuredContent;
      if (data?.execution_id) record.execution_id = data.execution_id;
      if (data?.id && name.startsWith('job_')) record.job_id = data.id;
    } catch (error) { record.status = 'error'; throw error; }
    finally {
      record.finished_at = new Date().toISOString(); record.duration_ms = Date.now() - start;
      await atomicJSON(filename, record);
      if (++this.completed % 100 === 0) await this.prune();
    }
    return { ...result, ...(result.structuredContent ? {structuredContent: { ...result.structuredContent, trace_id }} : {}),
      _meta: { ...result._meta, 'dev/trace_id': trace_id },
      content: [...result.content, { type: 'text', text: `Trace ID: ${trace_id}` }] };
  }
  async read({ trace_id, limit = 10 } = {}) {
    if (trace_id !== undefined && !validID.test(trace_id)) throw new Error('Invalid trace ID');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Trace limit must be 1..50');
    const files = (await readdir(this.root)).filter(name => /^\d+-[a-f0-9-]{36}\.json$/.test(name)).sort().reverse();
    const records = [];
    const counts = Object.create(null);
    for (const file of files) {
      let record;
      try { record = await readJSON(path.join(this.root, file)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      counts[record.tool] = (counts[record.tool] || 0) + 1;
      if (records.length < limit && (!trace_id || record.trace_id === trace_id)) records.push(record);
    }
    return { retention: 'Latest approximately ' + this.maxRecords + ' MCP calls; counts cover retained records only. Running records can indicate an interrupted HTTP call.',
      retained_calls: Object.values(counts).reduce((a, b) => a + b, 0), calls_by_tool: counts, calls: records };
  }
}
