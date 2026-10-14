// Opt-in, bounded, content-free MCP performance diagnostics.
// Never serialize request params, JSON-RPC IDs, headers, URLs, command/env,
// client addresses, terminal content or exception messages.
import { appendFile, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_PERFORMANCE = Object.freeze({enabled:false, maxFileMB:8, slowMs:250});
export function validatePerformance(input) {
  const p={...DEFAULT_PERFORMANCE,...input};
  if (!input || Array.isArray(input) || typeof input!=='object' ||
      Object.keys(input).some(x=>!Object.hasOwn(DEFAULT_PERFORMANCE,x)) ||
      typeof p.enabled!=='boolean' ||
      !Number.isSafeInteger(p.maxFileMB) || p.maxFileMB<1 || p.maxFileMB>32 ||
      !Number.isSafeInteger(p.slowMs) || p.slowMs<0 || p.slowMs>60000)
    throw new Error('Invalid performance debug settings');
  return p;
}
const round = value => Number.isFinite(value) ? Math.round(Math.max(0,value)*1000)/1000 : null;
const metric = (value,max=1e12) => Number.isFinite(value) ? Math.min(max,round(value)) : null;
const safeName = (value,max=80) => typeof value==='string' && /^[a-zA-Z][a-zA-Z0-9_/-]*$/.test(value) &&
  value.length<=max ? value : 'other';
const validTrace = value => typeof value==='string' && /^[0-9a-f-]{36}$/.test(value) ? value : undefined;

export class PerformanceLog {
  constructor(dataRoot) {
    this.file=path.join(dataRoot,'mcp-performance.jsonl');
    this.oldFile=this.file+'.1';
    this.config={...DEFAULT_PERFORMANCE};
    this.queue=Promise.resolve();
    this.queued=0;
    this.dropped=0;
    this.size=null;
    this.lastError=null;
  }
  configure(config) {this.config=validatePerformance(config);}
  enabled() {return this.config.enabled;}
  capture(raw) {
    if(!this.config.enabled)return;
    if(this.queued>=256){this.dropped++;return;}
    // Explicit allowlist; NEVER spread untrusted fields onto a log record.
    const entry={
      at:new Date().toISOString(),
      method:safeName(raw.method),
      tool:raw.tool ? safeName(raw.tool) : undefined,
      status:metric(raw.status,599),
      tool_error:raw.tool_error===1,
      rpc_error:raw.rpc_error===1,
      duration_ms:metric(raw.duration_ms),
      request_bytes:metric(raw.request_bytes),
      response_bytes:metric(raw.response_bytes),
      read_body_ms:metric(raw.read_body_ms),
      parse_ms:metric(raw.parse_ms),
      dispatch_ms:metric(raw.dispatch_ms),
      trace_id:validTrace(raw.trace_id),
      stages:Array.isArray(raw.stages)?raw.stages.slice(0,48).filter(x=>
        x && typeof x.stage==='string' && /^[a-z]+(?:[._][a-z]+)*$/.test(x.stage) && x.stage.length<=48
      ).map(x=>({stage:x.stage,at_ms:metric(x.at_ms)})):undefined,
      slow:Number.isFinite(raw.duration_ms) && raw.duration_ms>=this.config.slowMs
    };
    this.queued++;
    const pending=this.queue.then(()=>this.write(entry));
    this.queue=pending.catch(error=>{this.lastError=error.code||'WRITE_FAILED';}).finally(()=>{this.queued--;});
  }
  async write(entry) {
    const line=JSON.stringify(entry)+'\n';
    const bytes=Buffer.byteLength(line);
    if(this.size===null){
      try {this.size=(await stat(this.file)).size;}
      catch(error){if(error.code==='ENOENT')this.size=0;else throw error;}
    }
    if(this.size+bytes>this.config.maxFileMB*1024*1024){
      await rm(this.oldFile,{force:true});
      if(this.size>this.config.maxFileMB*1024*1024)await rm(this.file,{force:true});
      else try {await rename(this.file,this.oldFile);}
      catch(error){if(error.code!=='ENOENT')throw error;}
      this.size=0;
    }
    await appendFile(this.file,line,{encoding:'utf8',mode:0o600});
    this.size+=bytes;
  }
  async flush() {await this.queue;}
  async records(limit=100) {
    if(!Number.isSafeInteger(limit)||limit<1||limit>500)
      throw new Error('Performance page size must be 1–500');
    await this.flush();
    const lines=[];
    // Files are each size-bounded, but read only a bounded recent portion
    // to avoid materializing a huge log in the Admin process.
    for(const name of [this.file,this.oldFile]){
      let content;
      try {content=await readFile(name,'utf8');}
      catch(error){if(error.code==='ENOENT')continue;throw error;}
      const rows=content.split('\n').filter(Boolean).slice(-limit);
      lines.push(...rows.reverse().map(x=>{try{return JSON.parse(x);}catch{return null;}}).filter(Boolean));
      if(lines.length>=limit)break;
    }
    return lines.slice(0,limit);
  }
  async summary(limit=100){
    const items=await this.records(limit);
    const times=items.map(x=>x.duration_ms).filter(Number.isFinite).sort((a,b)=>a-b);
    const percentile=q=>times.length?times[Math.min(times.length-1,Math.ceil(q*times.length)-1)]:null;
    const aggregate={};
    for(const item of items){
      const name=item.tool||item.method;
      const slot=aggregate[name]??={calls:0,errors:0,total_ms:0,max_ms:0};
      slot.calls++;
      if(item.status>=400 || item.tool_error || item.rpc_error)slot.errors++;
      slot.total_ms+=item.duration_ms||0;
      slot.max_ms=Math.max(slot.max_ms,item.duration_ms||0);
    }
    const tools=Object.entries(aggregate).map(([name,x])=>({
      name,calls:x.calls,errors:x.errors,
      average_ms:round(x.total_ms/x.calls),max_ms:round(x.max_ms)
    })).sort((a,b)=>b.average_ms-a.average_ms);
    return {config:{...this.config},sample_count:items.length,
      p50_ms:percentile(0.50),p95_ms:percentile(0.95),p99_ms:percentile(0.99),
      dropped:this.dropped,write_error:this.lastError,tools,entries:items};
  }
  async clear(){
    const clearing=this.queue.then(async()=>{
      await rm(this.file,{force:true});await rm(this.oldFile,{force:true});
      this.size=0;this.dropped=0;this.lastError=null;
    });
    this.queue=clearing.catch(error=>{this.lastError=error.code||'CLEAR_FAILED';});
    await clearing;
  }
  async download(){
    await this.flush();
    const chunks=[];
    // Oldest-first export capped to 2 * maxFileMB.
    for(const filename of [this.oldFile,this.file]){
      try {chunks.push(await readFile(filename));}
      catch(error){if(error.code!=='ENOENT')throw error;}
    }
    return Buffer.concat(chunks);
  }
}
