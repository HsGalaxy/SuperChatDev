import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { atomicJSON, readJSON } from './common.mjs';

const context = new AsyncLocalStorage();
export const currentTrace = () => context.getStore()?.id;
// Safe in-memory milestones are persisted ONLY while the admin explicitly
// enables diagnostics. No arguments, output, errors or environment are kept.
export function tracePoint(stage, values={}) {
  const active=context.getStore();
  if(!active?.enabled || active.points.length>=48 ||
     typeof stage!=='string' || !/^[a-z]+(?:[._][a-z]+)*$/.test(stage) || stage.length>48)return;
  const point={stage,at_ms:Math.round((performance.now()-active.started)*1000)/1000};
  for(const [name,value] of Object.entries(values)){
    if(/^[a-z_]{1,24}$/.test(name) && typeof value==='number' && Number.isFinite(value))
      point[name]=Math.min(1e12,Math.max(0,Math.round(value*1000)/1000));
  }
  active.points.push(point);
}
const validID = /^[a-f0-9-]{36}$/;

export class Traces {
  constructor(dataRoot) { this.root = path.join(dataRoot, 'traces'); this.completed = 0; this.maxRecords = 5000; this.debugEnabled=false; this.recentDebug=new Map(); }
  configureDebug(enabled) {this.debugEnabled=enabled===true;if(!this.debugEnabled)this.recentDebug.clear();}
  takeDebug(trace_id) {const data=this.recentDebug.get(trace_id);this.recentDebug.delete(trace_id);return data||[];}
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
    const active={id:trace_id,enabled:this.debugEnabled,started:performance.now(),points:[]};
    try {
      result=await context.run(active,async()=>{
        tracePoint('tool.begin');
        try{return await operation();}
        finally {tracePoint('tool.end');}
      });
      record.status = result.isError ? 'error' : 'succeeded';
      const data = result.structuredContent;
      if (data?.execution_id) record.execution_id = data.execution_id;
      if (data?.id && name.startsWith('job_')) record.job_id = data.id;
    } catch (error) { record.status = 'error'; throw error; }
    finally {
      record.finished_at = new Date().toISOString(); record.duration_ms = Date.now() - start;
      if(active.enabled){
        record.debug={clock:'relative_ms',points:active.points,
          precision:'monotonic',note:'Metadata only; no arguments, outputs, headers, URLs or secrets'};
        this.recentDebug.set(trace_id,active.points);
        while(this.recentDebug.size>128)this.recentDebug.delete(this.recentDebug.keys().next().value);
      }
      await atomicJSON(filename, record);
      if (++this.completed % 100 === 0) await this.prune();
    }
    return { ...result, ...(result.structuredContent ? {structuredContent: { ...result.structuredContent, trace_id }} : {}),
      _meta: { ...result._meta, 'dev/trace_id': trace_id },
      content: [...result.content, { type: 'text', text: `Trace ID: ${trace_id}` }] };
  }
  async peek({limit=10,cursor}={}){
    // Bounded number of JSON reads, even with thousands of saved traces.
    if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw Error('Trace page limit must be 1..50');
    const names=(await readdir(this.root))
      .filter(x=>/^\d+-[a-f0-9-]{36}\.json$/.test(x)).sort().reverse();
    const start=cursor?names.findIndex(x=>x===cursor)+1:0;
    if(cursor&&start===0)throw Error('Unknown trace pagination cursor');
    const selected=names.slice(start,start+limit);
    const calls=[];
    for(const name of selected){
      try{calls.push(await readJSON(path.join(this.root,name)))}
      catch(e){if(e.code!=='ENOENT')throw e}
    }
    const calls_by_tool=Object.create(null);
    for(const call of calls)calls_by_tool[call.tool]=(calls_by_tool[call.tool]||0)+1;
    return {retention:'Bounded recent page; counts by tool are page-only, not whole history',
      retained_calls:names.length,calls_by_tool,calls,
      next_cursor:start+selected.length<names.length?selected.at(-1):null,
      counts_sample_only:true,mode:'summary'};
  }
  async read({ trace_id, limit = 10 } = {}) {
    if (trace_id !== undefined && !validID.test(trace_id)) throw new Error('Invalid trace ID');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Trace limit must be 1..50');
    const files = (await readdir(this.root)).filter(name => /^\d+-[a-f0-9-]{36}\.json$/.test(name)).sort().reverse();
    if(trace_id){
      // Exact Trace ID lookup: directory listing + ONE JSON read, instead of
      // reading every retained trace (formerly O(N) JSON parses).
      const name=files.find(file=>file.endsWith('-'+trace_id+'.json'));
      let record=null;
      if(name)try{record=await readJSON(path.join(this.root,name));}
      catch(error){if(error.code!=='ENOENT')throw error;}
      return {retention:'Exact trace lookup (counts limited to matched record)',
        retained_calls:record?1:0,calls_by_tool:record?{[record.tool]:1}:{},calls:record?[record]:[]};
    }
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
