import {constants} from 'node:fs';
import {open,readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const ROOT=fileURLToPath(new URL('../',import.meta.url));
const MAX_BYTES=256*1024;

export function parseDevelopmentLog(source){
 if(typeof source!=='string'||Buffer.byteLength(source)>MAX_BYTES)throw Error('Development log too large or invalid');
 const entries=[];let current=null;
 for(const raw of source.split(/\r?\n/)){
  const line=raw.trim();
  const heading=/^##\s+(.+)$/.exec(line);
  if(heading){
   if(entries.length>=100)break;
   const label=heading[1].slice(0,180);
   const matched=/^(v?\d+\.\d+\.\d+)\b/.exec(label);
   current={label,version:matched?.[1].replace(/^v/,'')||null,
    title:matched?label.slice(matched[0].length).replace(/^\s*[-–—:]\s*/,'').trim():label,
    kind:/^Unreleased\b/i.test(label)?'unreleased':matched?'release':'other',items:[]};
   entries.push(current);
  }else if(current&&/^[-*]\s+/.test(line)){
   if(current.items.length<100)current.items.push(line.slice(2).slice(0,1800));
  }else if(current?.items.length&&/^\s{2,}\S/.test(raw)){
   const i=current.items.length-1;
   current.items[i]=(current.items[i]+' '+line).slice(0,1800);
  }
 }
 return entries;
}

export async function readDevelopmentLog(){
 const f=await open(path.join(ROOT,'CHANGELOG.md'),constants.O_RDONLY|constants.O_NOFOLLOW);
 let contents;
 try{
  const before=await f.stat();
  if(!before.isFile()||before.size>MAX_BYTES)throw Error('Development log exceeds 256 KiB or is not regular');
  const data=Buffer.alloc(before.size+1);let n=0;
  while(n<data.length){
   const result=await f.read(data,n,data.length-n,n);
   if(!result.bytesRead)break;
   n+=result.bytesRead;
  }
  const after=await f.stat();
  if(n>MAX_BYTES||after.size!==before.size||after.mtimeMs!==before.mtimeMs)
   throw Error('Development log changed while reading');
  contents=new TextDecoder('utf-8',{fatal:true}).decode(data.subarray(0,n));
 }finally{await f.close();}
 const packageJson=JSON.parse(await readFile(path.join(ROOT,'package.json'),'utf8'));
 const entries=parseDevelopmentLog(contents);
 return {version:packageJson.version,entries,release_count:entries.filter(e=>e.kind==='release').length,source:'CHANGELOG.md'};
}
