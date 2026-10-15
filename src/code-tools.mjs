import path from 'node:path';
import { regexScanner } from './regex-search.mjs';
import { ripgrepSearch } from './ripgrep-search.mjs';
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
// Preserve a stable schema: an optional glob containing '/' matches the
// full cwd-relative path; simple globs continue to match basenames.
function searchGlob(pattern, filename) {
  if (!pattern) return true;
  if (!pattern.includes('/')) return globMatch(pattern, path.posix.basename(filename));
  const escaped = pattern.split(/(\*\*|\*|\?)/).map(part =>
    part === '**' ? '.*' : part === '*' ? '[^/]*' : part === '?' ? '[^/]' :
    part.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')).join('');
  const regex = new RegExp('^' + escaped.replace(/\.\*\//g, '(?:.*/)?') + '$');
  return regex.test(filename);
}
function context(lines, index) {
  const start = Math.max(0, index - 2), end = Math.min(lines.length, index + 3);
  return lines.slice(start,end).map((text,i) => ({
    line: start+i+1, text: text.slice(0,300).replace(/\r$/,'')
  }));
}
function pathHint(cwd, requested, error) {
  if (!['ENOENT','ENOTDIR'].includes(error?.code) && !/no such file|not a directory/i.test(error?.message || '')) return error.message;
  const project = relativePath(cwd), full = relativePath(requested);
  if (project !== '.' && full.startsWith(project + '/'))
    return `Path includes cwd prefix; use "${full.slice(project.length + 1)}" instead of "${full}" when cwd="${project}"`;
  return error.message;
}
const encodeCursor = data => Buffer.from(JSON.stringify(data)).toString('base64url');

export class CodeTools {
  constructor(config) { this.reader=new ScopedReader(config); this.rgPath=config.rgPath ?? '/usr/bin/rg'; this.rgIdentity={executionUid:config.executionUid,executionGid:config.executionGid}; }
  async list({cwd='.',path:directory='.',depth=1,limit=100,cursor:token,include_hidden=false,details=false}={}) {
    requireInteger(depth,1,1,4,'depth');requireInteger(limit,100,1,500,'limit');
    if(typeof include_hidden!=='boolean'||typeof details!=='boolean')throw new Error('include_hidden and details must be boolean');
    const data=await this.reader.inventory(cwd,directory,depth,include_hidden);
    const query=digest(JSON.stringify([cwd,directory,depth,include_hidden,details,data.entries]));
    const position=cursor(token,query);const entries=[];let outputBytes=0;
    for(const entry of data.entries.slice(position.index,position.index+limit)){
      let item=entry;
      if(details){
        if(entry.type==='file'||entry.type==='directory'){
          try {item={...entry,...await this.reader.metadata(cwd,entry.path,entry.type==='directory')};}
          catch {item={...entry,metadata_error:'Metadata unavailable or path changed'};}
        }else item={...entry,metadata_error:'Special files and symlinks are not followed'};
      }
      const bytes=Buffer.byteLength(JSON.stringify(item));if(outputBytes+bytes>65536)break;
      entries.push(item);outputBytes+=bytes;
    }
    const next=position.index+entries.length;
    return {cwd:relativePath(cwd),path:relativePath(directory),entries,returned:entries.length,
      next_cursor:next<data.entries.length?encodeCursor({query,index:next,line:0}):null,
      traversal_incomplete:data.limited,warnings:data.warnings,
      next_step:data.limited?'Tree limit reached; list a narrower subdirectory.':'Use fs_read for selected files or fs_search for literal code matches.'};
  }
  async read({cwd='.',files,max_bytes=32768}) {
    requireInteger(max_bytes,32768,1024,131072,'max_bytes');
    if(!Array.isArray(files)||!files.length||files.length>16)
      throw new Error('files must contain 1..16 file range objects');
    const results=[];let remaining=max_bytes;
    for(const request of files) {
      if(!request||typeof request!=='object'||typeof request.path!=='string')
        throw new Error('Each file requires path');
      const tail=request.tail_lines===undefined?null:requireInteger(request.tail_lines,20,1,500,'tail_lines');
      if(tail!==null && request.start_line!==undefined)
        throw new Error('Use either start_line or tail_lines, not both');
      const start=requireInteger(request.start_line,1,1,10000000,'start_line');
      const count=tail ?? requireInteger(request.line_count,160,1,500,'line_count');
      const result={path:relativePath(request.path),start_line:tail===null?start:null};
      try{
        let data;
        try{data=await this.reader.text(cwd,result.path);}
        catch(error){
          if(tail===null && /exceeds native text-read limit/.test(error.message)) {
            if(request.expected_sha256!==undefined)
              throw new Error('Large-file range cannot validate full-file SHA-256; omit expected_sha256');
            const win=await this.reader.window(cwd,result.path,start,count);
            let output='',returned=0;
            for(const line of win.lines){
              const piece=(start+returned)+': '+line+'\n';
              if(Buffer.byteLength(piece)>remaining)break;
              output+=piece;remaining-=Buffer.byteLength(piece);returned++;
            }
            Object.assign(result,{...win,numbered_text:output,end_line:start+returned-1,
              next_read:win.scan_limited?null:win.more||returned<win.lines.length?
                {path:result.path,start_line:start+returned,line_count:count}:null,
              truncated:win.scan_limited||win.more||returned<win.lines.length});
            if(win.scan_limited)result.warning='512 MiB streaming scan budget reached; use a narrower file or authorized command, not the same cursor';
            results.push(result);continue;
          }
          if(tail===null || !/exceeds native text-read limit/.test(error.message))throw error;
          if(request.expected_sha256!==undefined)
            throw new Error('Large-file tail cannot verify a full-file SHA-256; omit expected_sha256');
          const window=await this.reader.tail(cwd,result.path,tail);
          let output='',returned=0;
          for(let i=0;i<window.lines.length;i++){
            const piece='tail[-'+(window.lines.length-i)+']: '+window.lines[i]+'\n';
            if(Buffer.byteLength(piece)>remaining)break;
            output+=piece;remaining-=Buffer.byteLength(piece);returned++;
          }
          Object.assign(result,{
            sha256:null,bytes:window.bytes,total_lines:null,end_line:null,
            numbered_text:output,next_read:null,read_only_tail:true,
            line_numbers_relative:true,tail_window_truncated:window.window_truncated,
            truncated:returned<window.lines.length
          });
          if(window.window_truncated)
            result.warning='Tail was limited to the final 256 KiB; older lines may be unavailable';
          if(!output&&window.lines.length)result.error='Output budget exhausted or line exceeds max_bytes';
          results.push(result);continue;
        }
        if(request.expected_sha256!==undefined&&request.expected_sha256!==data.sha256)
          throw new Error('File changed since previous page; restart read without expected_sha256');
        const lines=data.text.split('\n');
        if(data.text.endsWith('\n'))lines.pop();
        if(!data.text.length)lines.length=0;
        const first=tail===null?start-1:Math.max(0,lines.length-count);
        let end=first,output='';
        for(let i=first;i<Math.min(lines.length,first+count);i++){
          const piece=(i+1)+': '+lines[i].replace(/\r$/,'')+'\n';
          if(Buffer.byteLength(piece)>remaining)break;
          output+=piece;remaining-=Buffer.byteLength(piece);end=i+1;
        }
        const more=tail===null&&end<lines.length;
        Object.assign(result,{
          start_line:first+1,sha256:data.sha256,bytes:data.bytes,total_lines:lines.length,
          end_line:end,numbered_text:output,
          next_read:more?{path:result.path,start_line:end+1,line_count:count,expected_sha256:data.sha256}:null,
          truncated:(tail!==null&&end<Math.min(lines.length,first+count))||
            (more&&end<start+count-1),read_only_tail:tail!==null
        });
        if((more||tail!==null)&&!output)result.error='Output budget exhausted or line exceeds max_bytes';
      }catch(error){result.error=pathHint(cwd,request.path,error);}
      results.push(result);
    }
    return {cwd:relativePath(cwd),files:results,output_bytes:max_bytes-remaining,
      next_step:'Use next_read for continuation. Files over 4 MiB support streaming line windows and tail_lines; partial reads have no full-file SHA-256, and cannot authorize guarded edits.'};
  }
  async search({cwd='.',path:directory='.',query,glob='',case_sensitive=true,regex=false,limit=40,cursor:token,engine='native',search_type='content'}={}) {
    if(typeof query!=='string'||!query.length||query.length>512||query.includes('\n'))
      throw new Error('query must be a nonempty single-line pattern, maximum 512 characters');
    if(typeof glob!=='string'||glob.length>256||typeof case_sensitive!=='boolean'||typeof regex!=='boolean')
      throw new Error('Invalid search filter');
    requireInteger(limit,40,1,200,'limit');
    if (!['native','ripgrep'].includes(engine) || !['content','files'].includes(search_type))
      throw new Error('Invalid search engine or type');
    if(engine==='ripgrep')return ripgrepSearch(this.reader,{cwd,directory,query,glob,case_sensitive,regex,limit,cursor:token,search_type,rgPath:this.rgPath,...this.rgIdentity});
    if(search_type!=='content')throw new Error('Filename search requires engine=ripgrep');
    const data=await this.reader.inventory(cwd,directory,32,false);
    const files=data.entries.filter(e=>e.type==='file'&&searchGlob(glob,e.path));
    const id=digest(JSON.stringify([cwd,directory,query,glob,case_sensitive,regex,files.map(e=>e.path)]));
    let {index,line}=cursor(token,id);
    const matches=[],skipped=[];let scanned=0,bytes=0,skippedCount=0,regexTimedOut=false;
    const needle=case_sensitive?query:query.toLocaleLowerCase();
    const deadline=Date.now()+1500;
    const scanner=regex?regexScanner(query,case_sensitive):null;
    try{
      for(;index<files.length;index++,line=0){
        if(scanned>=200||bytes>=8*1024*1024||Date.now()>deadline)break;
        let file;scanned++;
        try{file=await this.reader.text(cwd,files[index].path,1024*1024);}
        catch{
          skippedCount++;
          if(skipped.length<20)skipped.push({path:files[index].path,reason:'unreadable, binary or larger than 1 MiB'});
          continue;
        }
        bytes+=file.bytes;
        const lines=file.text.split('\n');
        if(regex){
          const found=await scanner.matches(file.text,line,limit-matches.length);
          if(found.timed_out){
            regexTimedOut=true;skippedCount++;
            if(skipped.length<20)skipped.push({path:files[index].path,reason:'regex worker timed out (possibly expensive pattern)'});
            index++;line=0;break;
          }
          for(const match of found.matches)matches.push({...match,path:files[index].path,sha256:file.sha256});
          line=found.nextLine;
        }else{
          for(;line<lines.length;line++){
            if((case_sensitive?lines[line]:lines[line].toLocaleLowerCase()).includes(needle)){
              const preview=lines[line].slice(0,600).replace(/\r$/,'');
              matches.push({path:files[index].path,line:line+1,text:preview,text_truncated:lines[line].length>600,context:context(lines,line),sha256:file.sha256});
              if(matches.length>=limit){line++;break;}
            }
          }
        }
        if(matches.length>=limit)break;
      }
    }finally{if(scanner)await scanner.close();}
    return {cwd:relativePath(cwd),query,regex,matches,scanned_files:scanned,skipped,skipped_count:skippedCount,
      warnings:data.warnings,regex_timed_out:regexTimedOut,
      next_cursor:index<files.length?encodeCursor({query:id,index,line}):null,traversal_incomplete:data.limited,
      next_step:regex?'Regex runs in a bounded worker; timed-out files are skipped. Verify matches with fs_read and use their SHA-256 for guarded edits.':'Literal search with +/-2 context lines; use fs_read and SHA-256 guards for edits.'};
  }

}
export const codeTools=[
 {name:'fs_list',title:'List project files',description:'Bounded, sorted project tree without a shell. Skips dependency/build/secret paths and never follows symlinks. Reuse next_cursor; traversal_incomplete means narrow the directory.',inputSchema:obj({...base,path:string('Directory relative to cwd, default dot'),depth:integer(1,4),limit:integer(1,500),cursor:string('Previous next_cursor'),include_hidden:{type:'boolean'},details:{type:'boolean',description:'Include bounded file size, modification time and permissions; no symlink following.'}}),annotations:readonly},
 {name:'fs_read',title:'Read numbered code ranges',description:'Read up to 16 UTF-8 files; tail_lines supports large files (without full hash), normal reads return line numbers and SHA-256. Per-file errors, shared output budget, next_read for continuation. Do not send displayed line prefixes back as file content.',inputSchema:{...obj({...base,files:{type:'array',minItems:1,maxItems:16,items:{...obj({path:string('File relative to cwd'),start_line:integer(1,10000000),line_count:integer(1,500),tail_lines:integer(1,500),expected_sha256:string('Optional hash returned by the previous page')}),required:['path']}},max_bytes:integer(1024,131072)}),required:['files']},annotations:readonly},
 {name:'fs_search',title:'Search project code',description:'Search code: native bounded scan by default; engine=ripgrep uses the installed /usr/bin/rg for large repositories, with file-name mode search_type=files, .gitignore support, no symlink traversal, explicit incomplete status and pagination. Fetch SHA-256 with fs_read before editing.',inputSchema:{...obj({...base,path:string('Subdirectory relative to cwd'),query:string('Single-line literal text'),glob:string('Optional basename wildcard'),case_sensitive:{type:'boolean'},regex:{type:'boolean',description:'Opt-in bounded JavaScript regex; literal by default.'},limit:integer(1,200),cursor:string('Previous next_cursor'),engine:{type:'string',enum:['native','ripgrep'],description:'ripgrep accelerates large repositories when /usr/bin/rg is installed; defaults to native scan'},search_type:{type:'string',enum:['content','files'],description:'Filename search requires engine=ripgrep'}}),required:['query']},annotations:readonly}
];
