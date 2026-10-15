// Optional fast search engine. The executable is a trusted local system package.
// Results are verified through ScopedReader before returning content to callers.
import {spawn} from 'node:child_process';
import {stat} from 'node:fs/promises';
import path from 'node:path';
import {DEFAULT_OMIT,sensitiveName,relativePath,digest} from './scoped-reader.mjs';
import {executionCommand} from './common.mjs';

const SKIP=[...DEFAULT_OMIT].map(name=>'!**/'+name+'/**');
const SECURE=['!**/.env','!**/.env.*','!**/*.pem','!**/*.key','!**/*.p12','!**/*.pfx',
  '!**/credentials.json','!**/id_rsa','!**/id_ed25519'];
export async function ripgrepSearch(reader,{cwd='.',directory='.',query,glob='',case_sensitive=true,regex=false,
 search_type='content',limit=40,cursor=null,rgPath='/usr/bin/rg',executionUid,executionGid}) {
 if(!['content','files'].includes(search_type))throw new Error('Invalid search_type');
 if(typeof query!=='string'||query.length>512||!query||query.includes('\0')||query.includes('\n'))
   throw new Error('Invalid search query');
 if(glob && (typeof glob!=='string'||glob.length>256||glob.includes('\0')))throw new Error('Invalid glob');
 if(search_type==='files' && regex)throw new Error('Filename mode uses a file glob, not content regex');
 if(search_type==='files' && glob)throw new Error('Filename mode uses query as the sole filename glob; omit glob');
 const {fd,actual}=await reader.handle(cwd,directory,true);await fd.close();
 const executable=rgPath;
 if(!path.isAbsolute(executable))throw new Error('ripgrep path must be absolute');
 const fileStat=await stat(executable).catch(()=>null);
 if(!fileStat?.isFile())throw new Error('ripgrep is not installed at '+executable);
 const args=['--no-config','--no-require-git','--no-follow','--color','never',
  ...(search_type==='files'?['--files']:['--json','--line-number','--max-columns','4096','--max-columns-preview']),
  ...(!case_sensitive&&search_type==='content'?['-i']:[]),
  ...(search_type==='content'&&!regex?['-F']:[]),
  ...(search_type==='files'?[case_sensitive?'-g':'--iglob',/[?*\[\]{}]/.test(query)?query:'*'+query+'*']:glob?['-g',glob]:[]),
  ...[...SKIP,...SECURE].flatMap(x=>['-g',x]),
  ...(search_type==='content'?['-e',query]:[]),
  '.'];
 const identifier=digest(JSON.stringify([cwd,directory,query,glob,regex,search_type,case_sensitive]));
 let offset=0;
 if(cursor){
  let parsed;try{parsed=JSON.parse(Buffer.from(cursor,'base64url').toString())}catch{throw new Error('Invalid cursor')}
  if(parsed.id!==identifier||!Number.isSafeInteger(parsed.offset)||parsed.offset<0||parsed.offset>50000)throw new Error('Invalid cursor');
  offset=parsed.offset;
 }
 return await new Promise((resolve,reject)=>{
  if(process.geteuid?.()===0 && executionUid===undefined)
    throw new Error('Refuse ripgrep as root without configured unprivileged execution identity');
  if(executionUid!==undefined && !Number.isSafeInteger(executionGid))
    throw new Error('ripgrep needs executionUid and executionGid');
  const [binary,arguments_]=executionCommand([executable,...args],executionUid!==undefined);
  const child=spawn(binary,arguments_,{
    cwd:actual,stdio:['ignore','pipe','pipe'],env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},detached:true,
    ...(executionUid!==undefined?{uid:executionUid,gid:executionGid}:{})
  });
  const matches=[],skipped=[],deadline=setTimeout(()=>kill(),4500);
  let tail='',stderr='',bytes=0,stopped=false,exitCode=null;
  function kill(){stopped=true;try{process.kill(-child.pid,'SIGKILL')}catch{}}
  const maxResults=Math.min(offset+limit+1,50100);
  function record(raw){
    if(matches.length>=maxResults)return;
    if(search_type==='files'){
      let file=raw.trim();if(!file)return;
      file=file.replace(/^\.\//,'');
      const parts=file.split('/');
      if(parts.some(x=>DEFAULT_OMIT.has(x)||sensitiveName(x)||x.startsWith('.')))return;
      matches.push({path:relativePath(path.posix.join(directory,file))});return;
    }
    let event;try{event=JSON.parse(raw)}catch{return}
    if(event.type!=='match')return;
    let file=event.data?.path?.text;
    const line=event.data?.line_number;
    if(!file||!Number.isInteger(line))return;
    file=file.replace(/^\.\//,'');
    const parts=file.split('/');
    if(parts.some(x=>DEFAULT_OMIT.has(x)||sensitiveName(x)||x.startsWith('.')))return;
    const source=relativePath(path.posix.join(directory,file));
    const text=event.data?.lines?.text||'';
    matches.push({path:source,line,text:text.trimEnd().slice(0,600),text_truncated:text.length>600});
  }
  child.stdout.on('data',chunk=>{
    bytes+=chunk.length;
    if(bytes>8*1024*1024){kill();return}
    tail+=chunk.toString('utf8');
    const lines=tail.split('\n');tail=lines.pop();
    for(const line of lines){record(line);if(matches.length>=maxResults){kill();break}}
  });
  child.stderr.on('data',buf=>{stderr+=(buf.toString()).slice(0,1024-stderr.length)});
  child.once('error',err=>{clearTimeout(deadline);reject(err)});
  child.once('close',async code=>{
    clearTimeout(deadline);exitCode=code;
    if(tail&&!stopped)record(tail);
    try{
      // Recheck every selected path with the strict no-symlink reader.
      const visible=[];
      for(const m of matches.slice(offset,offset+limit)){
        try{
          const h=await reader.handle(cwd,m.path);await h.fd.close();
          visible.push(m);
        }catch(e){if(skipped.length<20)skipped.push({path:m.path,reason:'not a safe regular file'})}
      }
      if(exitCode>1&&!stopped)throw new Error('ripgrep failed: '+stderr.slice(0,250));
      const next=matches.length>offset+limit && offset+limit<=50000;
      resolve({cwd,query,search_type,engine:'ripgrep',matches:visible,scanned_files:null,skipped,
        skipped_count:skipped.length,search_complete:!stopped&&!next,
        search_stopped:stopped,search_partial:stopped||skipped.length>0,
        next_cursor:next?Buffer.from(JSON.stringify({id:identifier,offset:offset+limit})).toString('base64url'):null,
        next_step:'Confirm match locations with fs_read before any edit; this fast index does not provide full-file SHA-256.'});
    }catch(err){reject(err)}
  });
 });
}
