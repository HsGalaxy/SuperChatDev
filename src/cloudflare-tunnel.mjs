// Optional Cloudflare Tunnel management. No npm/runtime dependency on cloudflared.
// Runs under the gateway's existing unprivileged UID. No sudo/shell invocation.
// API credentials are ephemeral; only a tunnel-scoped run token is persisted.
import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {access,chmod,mkdir,open,readFile,rename,rm,stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';

const MAX_JSON=64*1024;
const QUICK_RE=/https:\/\/([a-z0-9]+(?:-[a-z0-9]+)*)\.trycloudflare\.com\b/i;
const HOST_RE=/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const ID_RE=/^[a-f0-9]{32}$/i;
const UUID_RE=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const TOKEN_RE=/^[A-Za-z0-9._~+\-/=]{80,4096}$/;
const API_TOKEN_RE=/^[A-Za-z0-9_-]{20,512}$/;
const secrets=/eyJ[A-Za-z0-9._~+\-/=]{50,}|Bearer\s+\S+/gi;
const boundedMessage=value=>String(value||'').replace(secrets,'[REDACTED]').replace(/[\r\n\t]+/g,' ').slice(0,350);
export const cloudflaredInstallCommand="curl -fsSL https://raw.githubusercontent.com/HsGalaxy/SuperChatDev/main/install.sh | sudo bash -s -- --install-cloudflared --yes";

export function validateHostname(raw) {
 if(typeof raw!=='string')throw Error('Hostname is required');
 const hostname=raw.toLowerCase().trim();
 if(hostname.length>253||!HOST_RE.test(hostname)||hostname.endsWith('.trycloudflare.com')||
   hostname.endsWith('.localhost')||hostname.endsWith('.invalid')||hostname.endsWith('.example')||
   hostname.startsWith('*.'))throw Error('Use a fully qualified public hostname in your Cloudflare DNS zone');
 return hostname;
}
function requireId(value,label){
 if(typeof value!=='string'||!ID_RE.test(value))throw Error(label+' must be a 32-character Cloudflare hex ID');
 return value.toLowerCase();
}
function requireToken(value,label='Tunnel token'){
 if(typeof value!=='string'||!TOKEN_RE.test(value))throw Error(label+' is missing or invalid');
 return value;
}
function ensurePathInState(state,filename){
 const f=path.join(state,filename);
 if(path.dirname(f)!==state)throw Error('Unexpected tunnel storage path');
 return f;
}
async function safeRead(filepath,max=MAX_JSON){
 const fd=await open(filepath,constants.O_RDONLY|constants.O_NOFOLLOW);
 try {
  const s=await fd.stat();
  if(!s.isFile()||s.size>max||s.size===0||s.mode&0o077)throw Error('Unsafe tunnel state or permissions');
  return await fd.readFile('utf8');
 }finally{await fd.close();}
}
async function safeWrite(dir,filename,text){
 const file=ensurePathInState(dir,filename),tmp=ensurePathInState(dir,'.'+filename+'.'+randomUUID());
 const fd=await open(tmp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{await fd.writeFile(text,{encoding:'utf8'});await fd.sync();}finally{await fd.close();}
 await rename(tmp,file);
 await chmod(file,0o600);
}
async function boundedJson(response, secret){
 let bytes=0,parts=[];
 if(!response.body)throw Error('Cloudflare API returned no body');
 for await(const chunk of response.body){
  bytes+=chunk.length;
  if(bytes>MAX_JSON)throw Error('Cloudflare API response exceeds safe limit');
  parts.push(chunk);
 }
 let body;try{body=JSON.parse(Buffer.concat(parts).toString('utf8'))}catch{throw Error('Cloudflare API returned invalid JSON')}
 if(!response.ok||body.success!==true)
  throw Error('Cloudflare API request failed (HTTP '+response.status+'): '+boundedMessage(String(body.errors?.[0]?.message||'Check token permissions and Cloudflare zone').replaceAll(secret,'[REDACTED]')));
 return body.result;
}
export class CloudflareTunnel {
 constructor(config,options={}){
  this.dataRoot=config.dataRoot;this.port=config.port||8787;this.dir=path.join(this.dataRoot,'cloudflare-tunnel');
  this.originalBase=config.publicBaseURL||'';
  this.publishBase=options.publishBase||(()=>{});
  this.fetch=options.fetch||globalThis.fetch;
  this.spawn=options.spawn||spawn;
  this.bin=options.binary||config.cloudflaredExecutable||null;
  this.bootstrapQuick=config.tunnelBootstrapQuick===true;
  this.profile=null;this.child=null;this.mode='off';this.activeUrl=null;
  this.startedAt=null;this.lastError=null;this.logs=[];this.restartTimer=null;this.stopping=false;
  this.onExitListener=null;this.locked=false;this.lastUrlWrite=Promise.resolve();
 }
 async init(){
  await mkdir(this.dir,{recursive:true,mode:0o700});
  await chmod(this.dir,0o700);
  try{
   const p=JSON.parse(await safeRead(ensurePathInState(this.dir,'profile.json')));
   if(p.mode==='named'&&p.enabled===true&&validateHostname(p.hostname)===p.hostname &&
      (p.tunnelId===null||UUID_RE.test(p.tunnelId))){
    this.profile=p;
    // Do not fail the primary MCP runtime if cloudflared is unavailable.
    await this.launchNamed().catch(e=>{this.lastError=boundedMessage(e.message)});
   }
  }catch(e){if(e.code!=='ENOENT')this.lastError='Saved tunnel profile invalid; review the private state';}
  if(this.bootstrapQuick&&!this.profile){
    await rm(ensurePathInState(this.dir,'quick-url'),{force:true}).catch(()=>{});
    // Fresh install can assign the first public URL without requiring Admin
    // access through a hostname that has not yet been created.
    void this.quick().catch(e=>{this.lastError=boundedMessage(e.message)});
  }
 }
 async executable(){
  const candidates=this.bin?[this.bin]:['/usr/bin/cloudflared','/usr/local/bin/cloudflared'];
  for(const name of candidates){
   if(!path.isAbsolute(name))continue;
   try{
    const info=await stat(name);
    await access(name,constants.X_OK);
    if(info.isFile()&&!(info.mode&0o002))return name;
   }catch{}
  }
  return null;
 }
 async status(){
  const executable=await this.executable();
  return {installed:Boolean(executable),running:Boolean(this.child&&this.child.exitCode===null&&this.child.signalCode===null),
    mode:this.mode,configured:!!this.profile,autostart:!!this.profile?.enabled,
    hostname:this.profile?.hostname||null,url:this.activeUrl,
    public_url:this.activeUrl,mcp_url:this.activeUrl?this.activeUrl+'/mcp':null,
    admin_url:this.activeUrl?this.activeUrl+'/admin/':null,
    issuer:this.activeUrl||this.originalBase,
    pid:this.child?.pid||null,started_at:this.startedAt,
    tunnel_id:this.profile?.tunnelId||null,
    token_configured:!!this.profile,api_token_stored:false,
    last_error:this.lastError,diagnostic_lines:this.logs.slice(-8),
    recommended_access_order:['custom_domain','cloudflare_tunnel','sslip_io'],
    quick_testing_only:true,requires_binary_install:!executable,
    install_command:cloudflaredInstallCommand};
 }
 async statusCheck(){
  const origin='http://127.0.0.1:'+this.port+'/health';
  const response={...(await this.status()),origin:{ok:false},public:{ok:false}};
  try{
   const x=await this.fetch(origin,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(3500)});
   response.origin={ok:x.status===200,status:x.status};
  }catch(e){response.origin={ok:false,error:boundedMessage(e.message)}}
  if(this.activeUrl){
   try{
    const x=await this.fetch(this.activeUrl+'/health',{method:'GET',redirect:'manual',signal:AbortSignal.timeout(6500)});
    response.public={ok:x.status===200,status:x.status};
   }catch(e){response.public={ok:false,error:boundedMessage(e.message)}}
  }
  response.ready=Boolean(response.running&&response.origin.ok&&response.public.ok);
  return response;
 }
 async api(method,route,apiToken,body){
  const response=await this.fetch('https://api.cloudflare.com/client/v4'+route,{
   method,redirect:'error',headers:{Authorization:'Bearer '+apiToken,'Content-Type':'application/json'},
   ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)
  });
  return boundedJson(response,apiToken);
 }
 async createRemote({apiToken,accountId,zoneId,hostname,name}){
  if(this.child||this.profile)throw Error('Stop and remove the existing tunnel before provisioning another');
  if(typeof apiToken!=='string'||!API_TOKEN_RE.test(apiToken))throw Error('Cloudflare API token must be a valid secret token');
  const account=requireId(accountId,'Account ID'),zone=requireId(zoneId,'Zone ID');
  const host=validateHostname(hostname);
  if(typeof name!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,50}$/.test(name))
   throw Error('Tunnel name must contain 3-51 letters, numbers, underscores or hyphens');
  const prefix='/accounts/'+account+'/cfd_tunnel';
  const created=await this.api('POST',prefix,apiToken,{name,config_src:'cloudflare'});
  const tunnelId=created.id;
  if(!UUID_RE.test(tunnelId)||!TOKEN_RE.test(created.token||''))throw Error('Cloudflare did not return a usable tunnel ID/token');
  let configured=false,dnsRecordId=null;
  try{
   await this.api('PUT',prefix+'/'+tunnelId+'/configurations',apiToken,
    {config:{ingress:[{hostname:host,service:'http://127.0.0.1:'+this.port,originRequest:{}},{service:'http_status:404'}]}});
   configured=true;
   // Deliberately POST, never overwrite an unrelated hostname/DNS record.
   const dns=await this.api('POST','/zones/'+zone+'/dns_records',apiToken,
    {type:'CNAME',name:host,content:tunnelId+'.cfargotunnel.com',proxied:true});
   dnsRecordId=dns?.id||null;
   await this.saveNamed({hostname:host,token:created.token,tunnelId});
   return {provisioned:true,hostname:host,tunnel_id:tunnelId,...await this.status()};
  }catch(e){
   // Best-effort cleanup only for the tunnel created in this call.
   if(!this.profile){
    if(dnsRecordId){try{await this.api('DELETE','/zones/'+zone+'/dns_records/'+dnsRecordId,apiToken)}catch{}}
    try{await this.api('DELETE',prefix+'/'+tunnelId,apiToken)}catch{}
   }
   throw Error('Automatic provisioning failed'+(configured?' after tunnel configuration':'')+': '+boundedMessage(e.message));
  }
 }
 async saveNamed({hostname,token,tunnelId=null}){
  const host=validateHostname(hostname);
  requireToken(token);
  if(tunnelId!==null&&!UUID_RE.test(tunnelId))throw Error('Invalid tunnel ID');
  if(this.child||this.profile)throw Error('Remove the existing tunnel configuration before replacing it');
  await safeWrite(this.dir,'token',token+'\n');
  const profile={mode:'named',hostname:host,tunnelId,enabled:true,created_at:new Date().toISOString()};
  await safeWrite(this.dir,'profile.json',JSON.stringify(profile));
  this.profile=profile;
  try{await this.launchNamed()}catch(e){this.lastError=boundedMessage(e.message)}
  return await this.status();
 }
 async launchNamed(){
  if(!this.profile?.enabled)throw Error('Named tunnel not configured or is disabled');
  const token=await safeRead(ensurePathInState(this.dir,'token'),8192);
  requireToken(token.trim());
  const executable=await this.executable();
  if(!executable)throw Error('cloudflared is not installed. Use the optional install command first');
  await this.launch(executable,['tunnel','--no-autoupdate','run','--token-file',ensurePathInState(this.dir,'token')],'named');
  this.setURL('https://'+this.profile.hostname);
 }
 async quick(){
  if(this.child||this.profile)throw Error('Stop/remove the existing tunnel first');
  const executable=await this.executable();
  if(!executable)throw Error('cloudflared is not installed. Use the optional install command first');
  await this.launch(executable,['tunnel','--no-autoupdate','--url','http://127.0.0.1:'+this.port],'quick');
  try{
   const url=await new Promise((resolve,reject)=>{
    const deadline=setTimeout(()=>reject(Error('Cloudflare Quick Tunnel did not publish an address within 20s')),20000);
    const check=()=>{
     if(this.activeUrl){clearTimeout(deadline);resolve(this.activeUrl)}
     else if(!this.child){clearTimeout(deadline);reject(Error(this.lastError||'cloudflared exited before assigning a URL'))}
     else setTimeout(check,125);
    };check();
   });
   await this.lastUrlWrite;
   return {...await this.status(),quick_url:url};
  }catch(e){await this.stop({retainProfile:true});throw e}
 }
 setURL(url){
  this.activeUrl=url;
  this.publishBase(url);
  if(url&&this.mode==='quick'){
   console.info('[SuperChatDev Tunnel] Quick public URL: '+url);
   this.lastUrlWrite=safeWrite(this.dir,'quick-url',url+'\n').catch(e=>{
     this.lastError='Could not persist the Quick Tunnel address: '+boundedMessage(e.message);
   });
  }else if(!url){
   void rm(ensurePathInState(this.dir,'quick-url'),{force:true}).catch(()=>{});
  }
 }
 async launch(executable,args,mode){
  this.clearRestart();
  if(this.child)throw Error('Tunnel process is already running');
  this.stopping=false;this.mode=mode;this.activeUrl=null;this.lastError=null;this.logs=[];
  const child=this.spawn(executable,args,{stdio:['ignore','pipe','pipe'],env:{
   PATH:'/usr/local/bin:/usr/bin:/bin',HOME:this.dir,LANG:'C.UTF-8'
  },cwd:this.dir,windowsHide:true});
  this.child=child;this.startedAt=new Date().toISOString();
  this.onExitListener=()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM')};
  process.once('exit',this.onExitListener);
  let output='';
  const absorb=chunk=>{
   // 1 KiB partial buffer cap. Do not persist raw logs or any token.
   output=(output+chunk.toString('utf8')).slice(-1200);
   const lines=output.split(/\r?\n/);output=lines.pop();
   for(const line of lines){
    const safe=boundedMessage(line);
    if(safe&&!/token|Authorization|credential/i.test(safe)){
     this.logs.push(safe);if(this.logs.length>12)this.logs.shift();
    }
    if(mode==='quick'&&!this.activeUrl){
     const address=QUICK_RE.exec(line);
     if(address)this.setURL(address[0].toLowerCase());
    }
   }
   if(mode==='quick'&&!this.activeUrl){
    const match=QUICK_RE.exec(output);if(match)this.setURL(match[0].toLowerCase());
   }
  };
  child.stdout?.on('data',absorb);child.stderr?.on('data',absorb);
  const finished=(code,signal)=>{
   if(this.child!==child)return;
   this.child=null;
   if(this.onExitListener){process.removeListener('exit',this.onExitListener);this.onExitListener=null}
   this.lastError=this.stopping?null:'cloudflared exited ('+(signal||code)+'); check egress TCP/UDP 7844 and DNS';
   this.activeUrl=null;this.publishBase(null);
   if(mode==='named'&&!this.stopping&&this.profile?.enabled)this.scheduleRestart();
   else this.mode='off';
  };
  child.once('exit',finished);
  child.once('error',e=>{this.lastError=boundedMessage(e.message);if(this.child===child){this.child=null;this.mode='off';this.publishBase(null)}});
  await new Promise((resolve,reject)=>{
   if(child.pid){resolve();return}
   child.once('spawn',resolve);
   child.once('error',reject);
  });
 }
 scheduleRestart(){
  if(this.restartTimer)return;
  this.restartTimer=setTimeout(async()=>{
   this.restartTimer=null;
   if(!this.profile?.enabled||this.child)return;
   try{await this.launchNamed()}catch(e){this.lastError=boundedMessage(e.message)}
  },5000);
  this.restartTimer.unref?.();
 }
 clearRestart(){if(this.restartTimer)clearTimeout(this.restartTimer);this.restartTimer=null}
 async stop({retainProfile=true}={}){
  this.stopping=true;this.clearRestart();
  if(this.child){
   const child=this.child;
   child.kill('SIGTERM');
   await Promise.race([
    new Promise(resolve=>child.once('exit',resolve)),
    new Promise(resolve=>setTimeout(()=>{if(this.child===child)child.kill('SIGKILL');resolve()},2000))
   ]);
   this.child=null;
  }
  this.mode='off';this.setURL(null);this.lastError=null;
  if(this.profile){
   this.profile.enabled=false;
   if(!retainProfile){await rm(ensurePathInState(this.dir,'profile.json'),{force:true});await rm(ensurePathInState(this.dir,'token'),{force:true});this.profile=null}
   else await safeWrite(this.dir,'profile.json',JSON.stringify(this.profile));
  }
  this.stopping=false;
  return this.status();
 }
 async resume(){
  if(!this.profile)throw Error('No saved named tunnel');
  if(this.child)throw Error('Tunnel is already running');
  this.profile.enabled=true;
  await safeWrite(this.dir,'profile.json',JSON.stringify(this.profile));
  await this.launchNamed();
  return this.status();
 }
 async remove(){return this.stop({retainProfile:false})}
 async shutdown(){
  this.stopping=true;this.clearRestart();
  if(this.child)this.child.kill('SIGTERM');
 }
}
