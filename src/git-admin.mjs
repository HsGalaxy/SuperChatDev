import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executionCommand } from './common.mjs';

const workerPath = fileURLToPath(new URL('./git-admin-worker.mjs',import.meta.url));

// Git credentials are configured only under the actual command-execution UID,
// never under the Admin HTTP service's (usually different) Unix account.
// Privileged input lives in ephemeral stdin, not a durable job spec or trace.
export class GitAdmin {
  constructor(config) {
    const {workspace,executionUid,executionGid,executionHome}=config;
    this.workspace=workspace;
    this.uid=executionUid;
    this.gid=executionGid;
    this.home=executionHome || (executionUid===undefined ? os.homedir() : null);
    this.queue=Promise.resolve();
  }

  async run(action,params={}) {
    // Serialize settings writes and tests, avoiding concurrent key/config edits.
    const pending=this.queue.then(()=>this.execute(action,params));
    this.queue=pending.catch(()=>{});
    return pending;
  }

  async execute(action,params) {
    if(!this.home || !path.isAbsolute(this.home))
      throw new Error('EXECUTION_HOME must be configured to manage the runner Git identity');
    const payload=JSON.stringify({action,...params});
    if(Buffer.byteLength(payload)>20000)throw new Error('Git Admin request exceeds 20 KiB');
    const command=executionCommand([process.execPath,workerPath],this.uid!==undefined);
    const env={PATH:process.env.PATH||'/usr/local/bin:/usr/bin:/bin',HOME:this.home,LANG:'C.UTF-8',
      SCD_GIT_WORKSPACE:this.workspace};
    return await new Promise((resolve,reject)=>{
      const child=spawn(command[0],command[1],{
        cwd:this.workspace,env,stdio:['pipe','pipe','pipe'],
        ...(this.uid!==undefined?{uid:Number(this.uid),gid:Number(this.gid)}:{})
      });
      let out='',err='',settled=false;
      const rejectOnce=error=>{if(!settled){settled=true;clearTimeout(timer);reject(error);}};
      const timer=setTimeout(()=>{
        child.kill('SIGKILL');
        rejectOnce(new Error('Git operation timed out'));
      },27000);
      const append=(kind,bytes)=>{
        if(kind==='out')out+=bytes.toString('utf8');
        else err+=bytes.toString('utf8');
        if(Buffer.byteLength(out)+Buffer.byteLength(err)>65536){
          child.kill('SIGKILL');
          rejectOnce(new Error('Git operation produced too much output'));
        }
      };
      child.stdout.on('data',data=>append('out',data));
      child.stderr.on('data',data=>append('err',data));
      child.stdin.on('error',()=>{});
      child.once('error',error=>rejectOnce(new Error('Unable to launch Git manager: '+error.code)));
      child.once('close',code=>{
        if(settled)return;
        clearTimeout(timer);
        let result;
        try {result=JSON.parse(out.trim());}
        catch{rejectOnce(new Error('Git manager failed without structured output ('+code+')'));return;}
        if(result?.ok) {settled=true;resolve(result.result);}
        else rejectOnce(new Error((result?.error||'Git operation failed').slice(0,700)));
      });
      child.stdin.end(payload);
    });
  }
}
