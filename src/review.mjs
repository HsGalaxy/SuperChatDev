// Deliberately read-only: no commit/reset/checkout/push tool is introduced.
import { spawn } from 'node:child_process';
import { executionEnvironment } from './environment.mjs';
import { executionCommand, requireInteger } from './common.mjs';
import { ScopedReader, relativePath } from './scoped-reader.mjs';

export class Review {
  constructor(config) { this.config=config;this.reader=new ScopedReader(config); }
  async run(cwd,argv,budget) {
    const command=['git','--no-pager','--no-optional-locks','-c','core.fsmonitor=false',...argv];
    const [exe,args]=executionCommand(command,this.config.executionUid!==undefined);
    return await new Promise((resolve,reject)=>{
      const child=spawn(exe,args,{cwd,env:{...executionEnvironment(this.config),GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},
        ...(this.config.executionUid!==undefined?{uid:this.config.executionUid,gid:this.config.executionGid}:{}),stdio:['ignore','pipe','pipe']});
      let bytes=0,truncated=false,stderr='';const chunks=[];
      const timer=setTimeout(()=>{child.kill('SIGKILL');},10000);
      child.stdout.on('data',chunk=>{
        const keep=Math.min(chunk.length,Math.max(0,budget-bytes));
        if(keep)chunks.push(chunk.subarray(0,keep));bytes+=keep;
        if(keep<chunk.length){truncated=true;child.kill('SIGKILL');}
      });
      child.stderr.on('data',chunk=>{if(stderr.length<1024)stderr+=chunk.toString().slice(0,1024-stderr.length);});
      child.once('error',e=>{clearTimeout(timer);reject(e);});
      child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout:Buffer.concat(chunks).toString('utf8'),stderr,bytes,truncated});});
    });
  }
  async read({cwd='.',paths=[],max_bytes=32768}={}) {
    requireInteger(max_bytes,32768,1024,131072,'max_bytes');
    if(!Array.isArray(paths)||paths.length>32)throw new Error('paths must contain at most 32 project-relative paths');
    paths=paths.map(relativePath);
    const {fd,actual}=await this.reader.handle(cwd,'.',true);
    await fd.close();
    const root=await this.run(actual,['rev-parse','--show-toplevel'],4096);
    if(root.code!==0)return {cwd,git_available:false,error:root.stderr.trim()||'Not a Git repository',next_step:'Use fs_read or initialize Git explicitly with an authorized job. No files were changed.'};
    this.reader.check(root.stdout.trim());
    const gitDir=await this.run(actual,['rev-parse','--absolute-git-dir'],4096);
    if(gitDir.code!==0)throw new Error('Cannot determine Git metadata directory');
    this.reader.check(gitDir.stdout.trim());
    // Review can scope a subdirectory; --relative prevents paths outside the requested project.
    const status=await this.run(actual,['status','--porcelain=v1','-z','--untracked-files=normal','--',...(paths.length?paths:['.'])],Math.floor(max_bytes/4));
    const unstaged=await this.run(actual,['diff','--no-ext-diff','--no-textconv','--relative','--',...(paths.length?paths:['.'])],Math.floor(max_bytes/2));
    const staged=await this.run(actual,['diff','--cached','--no-ext-diff','--no-textconv','--relative','--',...(paths.length?paths:['.'])],Math.floor(max_bytes/4));
    const records=status.stdout.split('\0').filter(Boolean);const changes=[];
    for(let i=0;i<records.length;i++){
      const entry={status:records[i].slice(0,2),path:records[i].slice(3)};
      if(/[RC]/.test(entry.status))entry.previous_path=records[++i]||null;
      changes.push(entry);
    }
    return {cwd:relativePath(cwd),git_available:true,changes,
      unstaged_diff:unstaged.stdout,staged_diff:staged.stdout,
      truncated:status.truncated||unstaged.truncated||staged.truncated,
      errors:[status,unstaged,staged].filter(x=>x.code!==0&&!x.truncated).map(x=>x.stderr||'Git inspection timed out'),
      next_step:'Review changes and test exit codes before file_export. Untracked contents are not included in git diff; inspect them with fs_read. Narrow paths when truncated.'};
  }
}
export const reviewTool={name:'workspace_review',title:'Review Git changes without modifying them',
 description:'Read-only Git status and staged/unstaged diff, bounded output, no hooks/external diff/textconv. Does not initialize, commit, reset or push. Inspect untracked files with fs_read. No-Git projects return a clear fallback.',
 inputSchema:{type:'object',properties:{cwd:{type:'string'},paths:{type:'array',maxItems:32,items:{type:'string'}},max_bytes:{type:'integer',minimum:1024,maximum:131072}},additionalProperties:false},
 annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}};
