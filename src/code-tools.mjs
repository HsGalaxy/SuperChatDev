import path from 'node:path';
import { ScopedReader, digest, relativePath } from './scoped-reader.mjs';
import { requireInteger } from './common.mjs';

const obj = properties => ({type:'object',properties,additionalProperties:false});
const string = description => ({type:'string',description});
const integer = (minimum,maximum) => ({type:'integer',minimum,maximum});
const base = {cwd:string('Workspace-relative project root. Reuse the directory returned by file_unpack.')};
const readonly = {readOnlyHint:true,destructiveHint:false,openWorldHint:false};
function cursor(value, queryHash) {
  if (!value) return {index:0,line:0};
  try {
    if(typeof value!=='string'||value.length>512)throw new Error();
    const data=JSON.parse(Buffer.from(value,'base64url').toString());
    if(data.query!==queryHash || !Number.isSafeInteger(data.index)||data.index<0 || !Number.isSafeInteger(data.line)||data.line<0)throw new Error();
    return data;
  } catch { throw new Error('Invalid cursor or changed query; restart with no cursor'); }
}
function globMatch(pattern,text) {
  let p=0,t=0,star=-1,mark=0;
  while(t<text.length){
    if(p<pattern.length&&(pattern[p]==='?'||pattern[p]===text[t])){p++;t++;}
    else if(pattern[p]==='*'){star=p++;mark=t;}
    else if(star>=0){p=star+1;t=++mark;}
    else return false;
  }
  while(pattern[p]==='*')p++;
  return p===pattern.length;
}
const encodeCursor = data => Buffer.from(JSON.stringify(data)).toString('base64url');

export class CodeTools {
  constructor(config) { this.reader=new ScopedReader(config); }
  async list({cwd='.',path:directory='.',depth=1,limit=100,cursor:token,include_hidden=false}={}) {
    requireInteger(depth,1,1,4,'depth');requireInteger(limit,100,1,500,'limit');
    if(typeof include_hidden!=='boolean')throw new Error('include_hidden must be boolean');
    const data=await this.reader.inventory(cwd,directory,depth,include_hidden);
    const query=digest(JSON.stringify([cwd,directory,depth,include_hidden,data.entries]));
    const position=cursor(token,query);const entries=[];let outputBytes=0;
    for(const entry of data.entries.slice(position.index,position.index+limit)){
      const bytes=Buffer.byteLength(JSON.stringify(entry));if(outputBytes+bytes>65536)break;
      entries.push(entry);outputBytes+=bytes;
    }
    const next=position.index+entries.length;
    return {cwd:relativePath(cwd),path:relativePath(directory),entries,returned:entries.length,
      next_cursor:next<data.entries.length?encodeCursor({query,index:next,line:0}):null,
      traversal_incomplete:data.limited,warnings:data.warnings,
      next_step:data.limited?'Tree limit reached; list a narrower subdirectory.':'Use fs_read for selected files or fs_search for literal code matches.'};
  }
  async read({cwd='.',files,max_bytes=32768}) {
    requireInteger(max_bytes,32768,1024,131072,'max_bytes');
    if(!Array.isArray(files)||!files.length||files.length>16)throw new Error('files must contain 1..16 file range objects');
    const results=[];let remaining=max_bytes;
    for(const request of files) {
      if(!request||typeof request!=='object'||typeof request.path!=='string')throw new Error('Each file requires path');
      const start=requireInteger(request.start_line,1,1,10000000,'start_line');
      const count=requireInteger(request.line_count,160,1,500,'line_count');
      const result={path:relativePath(request.path),start_line:start};
      try {
        const data=await this.reader.text(cwd,result.path);
        if(request.expected_sha256!==undefined && request.expected_sha256!==data.sha256)throw new Error('File changed since previous page; restart read without expected_sha256');
        const lines=data.text.split('\n');if(data.text.endsWith('\n'))lines.pop();if(!data.text.length)lines.length=0;
        let end=start-1, output='';
        for(let i=start-1;i<Math.min(lines.length,start-1+count);i++) {
          const line=`${i+1}: ${lines[i].replace(/\r$/,'')}\n`;
          if(Buffer.byteLength(line)>remaining)break;
          output+=line;remaining-=Buffer.byteLength(line);end=i+1;
        }
        const more=end<lines.length;
        Object.assign(result,{sha256:data.sha256,bytes:data.bytes,total_lines:lines.length,end_line:end,numbered_text:output,
          next_read:more?{path:result.path,start_line:end+1,line_count:count,expected_sha256:data.sha256}:null,
          truncated:more && end<start+count-1});
        if(more&&!output)result.error='Output budget exhausted or line exceeds max_bytes; increase budget or use an authorized job';
      }catch(error){result.error=error.message;}
      results.push(result);
    }
    return {cwd:relativePath(cwd),files:results,output_bytes:max_bytes-remaining,
      next_step:'Reuse next_read entries in fs_read.files. Use the returned raw-byte sha256 as a workspace_execute write/patch guard. Number prefixes are display-only.'};
  }
  async search({cwd='.',path:directory='.',query,glob='',case_sensitive=true,limit=40,cursor:token}={}) {
    if(typeof query!=='string'||!query.length||query.length>512||query.includes('\n'))throw new Error('query must be a nonempty single-line literal, maximum 512 characters');
    if(typeof glob!=='string'||glob.length>256||typeof case_sensitive!=='boolean')throw new Error('Invalid search filter');
    requireInteger(limit,40,1,200,'limit');
    const data=await this.reader.inventory(cwd,directory,32,false);
    const files=data.entries.filter(e=>e.type==='file'&&(!glob||globMatch(glob,path.posix.basename(e.path))));
    const id=digest(JSON.stringify([cwd,directory,query,glob,case_sensitive,files.map(e=>e.path)]));
    let {index,line}=cursor(token,id);const matches=[],skipped=[];let scanned=0,bytes=0,skippedCount=0;
    const needle=case_sensitive?query:query.toLocaleLowerCase();
    const deadline=Date.now()+1500;
    for(;index<files.length;index++,line=0) {
      if(scanned>=200||bytes>=8*1024*1024||Date.now()>deadline)break;
      let file;scanned++;
      try{file=await this.reader.text(cwd,files[index].path,1024*1024);}catch{skippedCount++;if(skipped.length<20)skipped.push({path:files[index].path,reason:'unreadable, binary or larger than 1 MiB'});continue;}
      bytes+=file.bytes;
      const lines=file.text.split('\n');
      for(;line<lines.length;line++) {
        if((case_sensitive?lines[line]:lines[line].toLocaleLowerCase()).includes(needle)){
          const preview=lines[line].slice(0,600).replace(/\r$/,'');
          matches.push({path:files[index].path,line:line+1,text:preview,text_truncated:lines[line].length>600,sha256:file.sha256});
          if(matches.length>=limit){line++;break;}
        }
      }
      if(matches.length>=limit)break;
    }
    return {cwd:relativePath(cwd),query,matches,scanned_files:scanned,skipped,skipped_count:skippedCount,warnings:data.warnings,
      next_cursor:index<files.length?encodeCursor({query:id,index,line}):null,traversal_incomplete:data.limited,
      next_step:'Search is literal and excludes build/dependency/secret paths. Read matches with fs_read. Live edits can change pagination; hashes protect subsequent edits.'};
  }
}
export const codeTools=[
 {name:'fs_list',title:'List project files',description:'Bounded, sorted project tree without a shell. Skips dependency/build/secret paths and never follows symlinks. Reuse next_cursor; traversal_incomplete means narrow the directory.',inputSchema:obj({...base,path:string('Directory relative to cwd, default dot'),depth:integer(1,4),limit:integer(1,500),cursor:string('Previous next_cursor'),include_hidden:{type:'boolean'}}),annotations:readonly},
 {name:'fs_read',title:'Read numbered code ranges',description:'Read up to 16 UTF-8 files with line numbers and raw-byte SHA-256. Per-file errors, shared output budget, next_read for continuation. Do not send displayed line prefixes back as file content.',inputSchema:{...obj({...base,files:{type:'array',minItems:1,maxItems:16,items:{...obj({path:string('File relative to cwd'),start_line:integer(1,10000000),line_count:integer(1,500),expected_sha256:string('Optional hash returned by the previous page')}),required:['path']}},max_bytes:integer(1024,131072)}),required:['files']},annotations:readonly},
 {name:'fs_search',title:'Search project code',description:'Search literal text (no regex) in UTF-8 project files, with line numbers and hashes. Optional basename glob such as *.mjs. Bounded scan, explicit next_cursor and skipped files; excludes secrets/dependencies.',inputSchema:{...obj({...base,path:string('Subdirectory relative to cwd'),query:string('Single-line literal text'),glob:string('Optional basename wildcard'),case_sensitive:{type:'boolean'},limit:integer(1,200),cursor:string('Previous next_cursor')}),required:['query']},annotations:readonly}
];
