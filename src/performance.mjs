// Opt-in MCP observability. Metadata and sensitive message bodies are stored in
// SEPARATE bounded journals. No body cloning or logging runs with debug disabled.
// NEVER capture HTTP Authorization/Cookie headers, remote IPs or Admin requests.
import { appendFile, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_PERFORMANCE=Object.freeze({
  enabled:false,captureContent:false,maxFileMB:8,maxContentFileMB:16,maxBodyKB:512,slowMs:250
});
const MiB=1024*1024;
const captureID=id=>typeof id==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
export function validatePerformance(input) {
  const p={...DEFAULT_PERFORMANCE,...input};
  if (!input || Array.isArray(input) || typeof input!=='object' ||
      Object.keys(input).some(x=>!Object.hasOwn(DEFAULT_PERFORMANCE,x)) ||
      typeof p.enabled!=='boolean' || typeof p.captureContent!=='boolean' ||
      (p.captureContent && !p.enabled) ||
      !Number.isSafeInteger(p.maxFileMB) || p.maxFileMB<1 || p.maxFileMB>32 ||
      !Number.isSafeInteger(p.maxContentFileMB) || p.maxContentFileMB<1 || p.maxContentFileMB>32 ||
      !Number.isSafeInteger(p.maxBodyKB) || p.maxBodyKB<16 || p.maxBodyKB>4096 ||
      !Number.isSafeInteger(p.slowMs) || p.slowMs<0 || p.slowMs>60000)
    throw new Error('Invalid performance debug settings');
  return p;
}
const round=value=>Number.isFinite(value)?Math.round(Math.max(0,value)*1000)/1000:null;
const metric=(value,max=1e12)=>Number.isFinite(value)?Math.min(max,round(value)):null;
const safeName=(value,max=80)=>typeof value==='string' && /^[a-zA-Z][a-zA-Z0-9_/-]*$/.test(value) &&
  value.length<=max?value:'other';
const validTrace=value=>typeof value==='string' && /^[0-9a-f-]{36}$/.test(value)?value:undefined;

// Every captured field comes from the already-received JSON-RPC body or the
// exact already-serialized JSON-RPC response. Large messages retain head and
// tail with explicit truncation metadata; they are NOT represented as complete.
function boundedBody(raw,maxBytes){
  if(typeof raw!=='string')return {present:false,bytes:0,truncated:false};
  const bytes=Buffer.byteLength(raw);
  if(bytes<=maxBytes)return {present:true,bytes,truncated:false,text:raw};
  const buffer=Buffer.from(raw,'utf8');
  const first=Math.floor(maxBytes*0.65),last=maxBytes-first;
  return {present:true,bytes,truncated:true,omitted_bytes:bytes-maxBytes,
    text:buffer.subarray(0,first).toString('utf8')+
      '\n...[MIDDLE OMITTED: '+(bytes-maxBytes)+' BYTES]...\n'+
      buffer.subarray(bytes-last).toString('utf8')};
}
function contentRecord(raw,config){
  const limit=config.maxBodyKB*1024;
  return {at:new Date().toISOString(),capture_id:raw.capture_id,
    trace_id:validTrace(raw.trace_id),method:safeName(raw.method),
    tool:raw.tool?safeName(raw.tool):undefined,
    request:boundedBody(raw.request_body,limit),
    response:boundedBody(raw.response_body,limit)};
}
export class PerformanceLog {
  constructor(dataRoot){
    this.file=path.join(dataRoot,'mcp-performance.jsonl');
    this.oldFile=this.file+'.1';
    this.contentFile=path.join(dataRoot,'mcp-content.jsonl');
    this.oldContentFile=this.contentFile+'.1';
    this.config={...DEFAULT_PERFORMANCE};
    this.queue=Promise.resolve();
    this.queued=0;this.dropped=0;this.contentDropped=0;
    this.queuedContentBytes=0;
    this.size=null;this.contentSize=null;this.lastError=null;
  }
  configure(config){this.config=validatePerformance(config);}
  enabled(){return this.config.enabled;}
  contentEnabled(){return this.config.enabled && this.config.captureContent;}

  capture(raw){
    if(!this.config.enabled)return;
    if(this.queued>=256){this.dropped++;return;}
    // Explicit field allowlist. Unknown request properties are NEVER serialized
    // to metrics, including raw request/response bodies.
    const entry={
      at:new Date().toISOString(),
      method:safeName(raw.method),
      tool:raw.tool?safeName(raw.tool):undefined,
      status:metric(raw.status,599),tool_error:raw.tool_error===1,
      rpc_error:raw.rpc_error===1,
      duration_ms:metric(raw.duration_ms),
      request_bytes:metric(raw.request_bytes),
      response_bytes:metric(raw.response_bytes),
      read_body_ms:metric(raw.read_body_ms),
      parse_ms:metric(raw.parse_ms),
      dispatch_ms:metric(raw.dispatch_ms),
      trace_id:validTrace(raw.trace_id),
      stages:Array.isArray(raw.stages)?raw.stages.slice(0,48).filter(x=>
        x && typeof x.stage==='string' &&
        /^[a-z]+(?:[._][a-z]+)*$/.test(x.stage) && x.stage.length<=48
      ).map(x=>({stage:x.stage,at_ms:metric(x.at_ms)})):undefined,
      slow:Number.isFinite(raw.duration_ms)&&raw.duration_ms>=this.config.slowMs
    };
    const settings=this.config;
    const wantsContent=settings.captureContent && captureID(raw.capture_id);
    // Clip BEFORE queueing so a stalled disk cannot retain 256 unbounded
    // multi-megabyte original responses in the job queue.
    let captured=wantsContent?contentRecord(raw,settings):null;
    const contentBytes=captured?
      Buffer.byteLength(captured.request.text||'')+Buffer.byteLength(captured.response.text||''):0;
    if(captured && this.queuedContentBytes+contentBytes>32*MiB){
      this.contentDropped++;
      captured=null;
    }
    if(captured){
      entry.capture_id=raw.capture_id;
      this.queuedContentBytes+=contentBytes;
    }
    this.queued++;
    const pending=this.queue.then(async()=>{
      await this.write(entry);
      if(captured)await this.writeContent(captured,settings.maxContentFileMB*MiB);
    });
    this.queue=pending.catch(error=>{this.lastError=error.code||'WRITE_FAILED';})
      .finally(()=>{
        this.queued--;
        if(captured)this.queuedContentBytes-=contentBytes;
      });
  }

  // Two independent, bounded journals; current + one rotated predecessor.
  async appendRotated(filename,older,field,cap,line){
    const bytes=Buffer.byteLength(line);
    if(bytes>cap)throw new Error('Journal record exceeds file limit');
    if(this[field]===null){
      try{this[field]=(await stat(filename)).size;}
      catch(error){if(error.code==='ENOENT')this[field]=0;else throw error;}
    }
    if(this[field]+bytes>cap){
      await rm(older,{force:true});
      if(this[field]>cap)await rm(filename,{force:true});
      else try{await rename(filename,older);}
      catch(error){if(error.code!=='ENOENT')throw error;}
      this[field]=0;
    }
    await appendFile(filename,line,{encoding:'utf8',mode:0o600});
    this[field]+=bytes;
  }
  async write(entry){
    await this.appendRotated(this.file,this.oldFile,'size',
      this.config.maxFileMB*MiB,JSON.stringify(entry)+'\n');
  }
  async writeContent(entry,maxBytes){
    let line=JSON.stringify(entry)+'\n';
    if(Buffer.byteLength(line)>maxBytes){
      // Escaping can expand output (e.g. lots of control characters). In that
      // case record honest metadata, never exceed the configured disk cap.
      const omitted=body=>({...body,text:undefined,truncated:true,
        skipped:'escaped_content_exceeds_journal_limit'});
      line=JSON.stringify({...entry,request:omitted(entry.request),
        response:omitted(entry.response)})+'\n';
    }
    await this.appendRotated(this.contentFile,this.oldContentFile,
      'contentSize',maxBytes,line);
  }
  async flush(){await this.queue;}
  async records(limit=100){
    if(!Number.isSafeInteger(limit)||limit<1||limit>500)
      throw new Error('Performance page size must be 1–500');
    await this.flush();
    const lines=[];
    // Content journals are NEVER loaded into the regular metrics dashboard.
    for(const name of [this.file,this.oldFile]){
      let content;
      try{content=await readFile(name,'utf8');}
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
      const slot=aggregate[name]??={calls:0,errors:0,transport_errors:0,tool_errors:0,rpc_errors:0,total_ms:0,max_ms:0};
      slot.calls++;
      if(item.status>=400)slot.transport_errors++;
      if(item.tool_error)slot.tool_errors++;
      if(item.rpc_error)slot.rpc_errors++;
      if(item.status>=400||item.tool_error||item.rpc_error)slot.errors++;
      slot.total_ms+=item.duration_ms||0;
      slot.max_ms=Math.max(slot.max_ms,item.duration_ms||0);
    }
    const tools=Object.entries(aggregate).map(([name,x])=>({
      name,calls:x.calls,errors:x.errors,transport_errors:x.transport_errors,
      tool_errors:x.tool_errors,rpc_errors:x.rpc_errors,
      average_ms:round(x.total_ms/x.calls),max_ms:round(x.max_ms)
    })).sort((a,b)=>b.average_ms-a.average_ms);
    return {config:{...this.config},sample_count:items.length,
      p50_ms:percentile(0.50),p95_ms:percentile(0.95),p99_ms:percentile(0.99),
      dropped:this.dropped,content_dropped:this.contentDropped,
      write_error:this.lastError,tools,entries:items};
  }
  async readContent(id){
    if(!captureID(id))throw new Error('Invalid MCP capture ID');
    await this.flush();
    const needle='"capture_id":"'+id+'"';
    for(const name of [this.contentFile,this.oldContentFile]){
      let content;
      try{content=await readFile(name,'utf8');}
      catch(error){if(error.code==='ENOENT')continue;throw error;}
      const rows=content.split('\n');
      for(let i=rows.length-1;i>=0;i--){
        if(!rows[i].includes(needle))continue;
        const item=JSON.parse(rows[i]);
        if(item.capture_id===id)return item;
      }
    }
    return null;
  }
  async downloadFiles(paths){
    await this.flush();
    const chunks=[];
    for(const filename of paths){
      try{chunks.push(await readFile(filename));}
      catch(error){if(error.code!=='ENOENT')throw error;}
    }
    return Buffer.concat(chunks);
  }
  async download(){return this.downloadFiles([this.oldFile,this.file]);}
  async downloadContent(){return this.downloadFiles([this.oldContentFile,this.contentFile]);}

  async clear(){
    const clearing=this.queue.then(async()=>{
      for(const filename of [this.file,this.oldFile,this.contentFile,this.oldContentFile])
        await rm(filename,{force:true});
      this.size=0;this.contentSize=0;this.dropped=0;
      this.contentDropped=0;this.lastError=null;
    });
    this.queue=clearing.catch(error=>{this.lastError=error.code||'CLEAR_FAILED';});
    await clearing;
  }
}
