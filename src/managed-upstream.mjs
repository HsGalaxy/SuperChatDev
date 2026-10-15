// Optional DC bridge: bounded startup, reconnect with backoff, NEVER replay calls.
import path from 'node:path';
import { StdioUpstream } from './upstream.mjs';
import { atomicJSON, readJSON } from './common.mjs';
export class ManagedUpstream {
  constructor(argv,config={}) {
    this.argv=argv;this.config=config;this.info={capabilities:{}};this.tools=[];
    this.client=null;this.connecting=null;this.closed=false;this.ready=false;this.retry=null;this.attempts=0;
    this.suspended=false;this.draining=new Set();
    this.cache=config.dataRoot?path.join(config.dataRoot,'upstream-catalog.json'):null;
  }
  status(){return {configured:true,connected:this.ready,attempts:this.attempts,cached_tools:this.tools.length,state:this.closed?'closed':this.suspended?'idle':this.ready?'connected':this.connecting?'connecting':'backoff',automatic_replay:false};}
  async init({connect=true}={}) {
    if(this.cache){
      try {const data=await readJSON(this.cache);if(data.version===1&&Array.isArray(data.tools))this.tools=data.tools.filter(x=>typeof x.name==='string'&&x.inputSchema?.type==='object');}
      catch(e){if(e.code!=='ENOENT')this.cache_warning=true;}
    }
    if(connect)try{await this.connect();}catch{/* Core service remains available. */}
  }
  schedule() {
    if(this.closed||this.suspended||this.retry)return;
    this.retry=setTimeout(()=>{this.retry=null;this.connect().catch(()=>{});},Math.min(30000,1000*2**Math.min(this.attempts,5)));
    this.retry.unref();
  }
  connect() {
    if(this.closed)return Promise.reject(new Error('Upstream is closed'));
    if(this.suspended)return Promise.reject(new Error('Upstream disabled in this tool profile'));
    if(this.connecting)return this.connecting;
    this.connecting=(async()=>{
      this.attempts++;
      const client=new StdioUpstream(this.argv,{...this.config,spawnProcess:this.config.upstreamSpawn});
      this.client=client;
      let timer;
      try{
        const tools=await Promise.race([(async()=>{await client.init();return client.info.capabilities?.tools?await client.listAll('tools/list','tools'):[];})(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Upstream startup timeout')),2000);})]);
        if(this.closed || this.suspended || this.client!==client)throw new Error('Upstream stopped');
        this.tools=tools;this.info=client.info;this.ready=true;this.attempts=0;
        if(this.cache)await atomicJSON(this.cache,{version:1,tools}).catch(()=>{this.cache_warning=true;});
        this.onTools?.(tools);
        client.process.once('exit',()=>{if(this.client===client){this.ready=false;this.schedule();}});
      }catch(error){this.ready=false;client.close();this.schedule();throw error;}
      finally{clearTimeout(timer);}
    })().finally(()=>{this.connecting=null;});
    return this.connecting;
  }
  async resume() {
    if(this.closed)throw new Error('Upstream closed');
    this.suspended=false;
    if(!this.ready)try{await this.connect()}catch{/* Cached catalog remains available during outages. */}
  }
  pause() {
    // Do not interrupt requests already forwarded to DC; stop new calls now,
    // then drain the old client without delaying Admin configuration writes.
    this.suspended=true;this.ready=false;
    clearTimeout(this.retry);this.retry=null;
    const old=this.client;
    this.client=null;
    if(!old)return;
    this.draining.add(old);
    const started=Date.now();
    const interval=setInterval(()=>{
      if(old.pending.size===0||Date.now()-started>120000||this.closed){
        clearInterval(interval);
        this.draining.delete(old);
        old.close();
      }
    },50);
    interval.unref();
  }
  async request(method,params) {
    // Fail promptly during outages. A fresh call after recovery is explicit user/model action.
    if(!this.ready)throw new Error('Desktop Commander is reconnecting; use core tools. Do not repeat a mutating command until its outcome is known.');
    try{return await this.client.request(method,params);}
    catch(error){if(this.client.failure){this.ready=false;this.schedule();}throw error;}
  }
  listAll(method,key) {return this.ready?this.client.listAll(method,key):Promise.resolve([]);}
  close(){this.closed=true;this.ready=false;clearTimeout(this.retry);this.client?.close();for(const client of this.draining)client.close();this.draining.clear();}
}
