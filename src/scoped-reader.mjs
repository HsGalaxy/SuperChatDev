// Linux workspace reader. Pin each directory handle; never follow user symlinks.
import { constants } from 'node:fs';
import { open, realpath, opendir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isInside } from './common.mjs';
export const digest = value => createHash('sha256').update(value).digest('hex');
export const DEFAULT_OMIT = new Set(['.git','node_modules','target','dist','build','.venv','venv','__pycache__','.chatgpt-mcp']);
export const sensitiveName = name => /^\.env(?:\.|$)/.test(name) || /\.(?:pem|key|p12|pfx)$/i.test(name) || ['id_rsa','id_ed25519','credentials.json'].includes(name);
export function relativePath(value = '.') {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\0\\]/.test(value) || path.isAbsolute(value) || value.split('/').includes('..')) throw new Error('Use a workspace-relative path without .. or symlinks');
  return value.split('/').filter(p => p && p !== '.').join('/') || '.';
}
export class ScopedReader {
  constructor({workspace, dataRoot}) { this.root = path.resolve(workspace); this.denied = dataRoot ? path.resolve(dataRoot) : null; }
  check(full) {
    if (!isInside(this.root, full) || (this.denied && isInside(this.denied, full))) throw new Error('Path escapes workspace or addresses private MCP state');
  }
  async handle(cwd = '.', relative = '.', directory = false) {
    cwd = relativePath(cwd); relative = relativePath(relative);
    const full = path.resolve(this.root, cwd, relative);
    this.check(full);
    const parts = path.relative(this.root, full).split(path.sep).filter(Boolean);
    let fd = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      for (let i = 0; i < parts.length; i++) {
        const isDir = i < parts.length - 1 || directory;
        const next = await open(`/proc/self/fd/${fd.fd}/${parts[i]}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (isDir ? constants.O_DIRECTORY : 0));
        await fd.close(); fd = next;
      }
      const actual = await realpath(`/proc/self/fd/${fd.fd}`);
      this.check(actual);
      const stat = await fd.stat();
      if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error('Expected a ' + (directory ? 'directory' : 'regular file'));
      if (!directory && stat.nlink > 1) throw new Error('Hard-linked files are not accepted by native file readers');
      return {fd, stat, actual};
    } catch (error) { await fd.close(); throw error; }
  }
  async text(cwd, file, maxBytes = 4 * 1024 * 1024) {
    const {fd, stat} = await this.handle(cwd, file);
    try {
      if (stat.size > maxBytes) throw new Error('File exceeds native text-read limit; narrow the search or use an explicitly authorized job');
      // Bound allocation even if a concurrent process grows the file.
      const buffer = Buffer.alloc(Math.min(maxBytes + 1, stat.size + 1));
      let bytes = 0;
      while (bytes < buffer.length) {
        const read = await fd.read(buffer, bytes, buffer.length - bytes, bytes);
        if (!read.bytesRead) break;
        bytes += read.bytesRead;
      }
      const after = await fd.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || bytes > maxBytes) throw new Error('File changed while being read; retry');
      const raw = buffer.subarray(0, bytes);
      const text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(raw);
      if (text.includes('\0')) throw new Error('Binary file; use file_export instead');
      return {text, bytes, sha256: digest(raw)};
    } finally { await fd.close(); }
  }
  async tail(cwd, file, count, maxBytes = 256 * 1024) {
    const {fd,stat}=await this.handle(cwd,file);
    try{
      // Bounded reverse reading; the first partial line is discarded when
      // seeking starts in the middle of the file.
      const chunks=[];let position=stat.size,scanned=0,newlines=0;
      while(position>0&&scanned<maxBytes&&newlines<=count+1){
        const n=Math.min(32768,position,maxBytes-scanned);
        const chunk=Buffer.alloc(n);
        const start=position-n;
        const {bytesRead}=await fd.read(chunk,0,n,start);
        if(bytesRead!==n)throw new Error('File changed while reading tail; retry');
        chunks.unshift(chunk);
        for(const byte of chunk)if(byte===10)newlines++;
        scanned+=n;position=start;
      }
      const after=await fd.stat();
      if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs)
        throw new Error('File changed while reading tail; retry');
      let raw=Buffer.concat(chunks);
      if(position>0){
        const cut=raw.indexOf(10);
        if(cut<0)throw new Error('Last complete line exceeds the 256 KiB tail window');
        raw=raw.subarray(cut+1);
      }
      const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw);
      if(text.includes('\0'))throw new Error('Binary file; use file_export instead');
      const lines=text.split('\n');
      if(text.endsWith('\n'))lines.pop();
      if(!text.length)lines.length=0;
      return {lines:lines.slice(-count).map(line=>line.replace(/\r$/,'')),
        bytes:stat.size,window_truncated:position>0&&lines.length<count};
    }finally{await fd.close();}
  }
  async metadata(cwd, file, directory = false) {
    const {fd,stat}=await this.handle(cwd,file,directory);
    try {
      return {size:stat.size,modified_at:stat.mtime.toISOString(),
        permissions:'0'+(stat.mode&0o777).toString(8)};
    } finally { await fd.close(); }
  }
  async entries(cwd, relative) {
    const {fd} = await this.handle(cwd, relative, true);
    try {
      const dir = await opendir(`/proc/self/fd/${fd.fd}`);
      const entries=[];let limited=false;
      for await(const item of dir){
        if(entries.length>=10000){limited=true;break;}
        entries.push({name:item.name,type:item.isDirectory()?'directory':item.isFile()?'file':item.isSymbolicLink()?'symlink':'special'});
      }
      return {entries:entries.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0),limited};
    } finally { await fd.close(); }
  }
  async inventory(cwd, directory, depth = 1, includeHidden = false, maxEntries = 5000) {
    cwd=relativePath(cwd); directory=relativePath(directory);
    const entries=[], warnings=[]; let limited=false,stop=false;
    const walk=async (dir,level)=>{
      let list;
      try { const data=await this.entries(cwd,dir);list=data.entries;if(data.limited){limited=true;warnings.push({path:dir,error:'Directory exceeds 10000 entries; listing is partial'});} }
      catch(error) { if (level===0) throw error; if(warnings.length<20)warnings.push({path:dir,error:'Directory unreadable; skipped'}); return; }
      for (const item of list) {
        if (DEFAULT_OMIT.has(item.name) || sensitiveName(item.name) || (!includeHidden && item.name.startsWith('.'))) continue;
        const target=relativePath(path.posix.join(dir,item.name));
        if (this.denied && isInside(this.denied,path.resolve(this.root,cwd,target))) continue;
        if(entries.length>=maxEntries){ limited=true;stop=true;return; }
        entries.push({...item,path:target});
        if(item.type==='directory' && level+1<depth) await walk(target,level+1);
        if(stop)return;
      }
    };
    await walk(directory,0);
    return {entries,warnings,limited};
  }
}
