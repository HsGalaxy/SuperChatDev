// Read-only current cgroup v2 usage; does not inspect request or content logs.
import {readFile} from 'node:fs/promises';
import path from 'node:path';

const ROOT='/sys/fs/cgroup';
export function parseEvents(text=''){
 const pairs=Object.create(null);
 for(const line of text.trim().split('\n')){
  const [key,value]=line.trim().split(/\s+/);
  if(key&&/^\d+$/.test(value||''))pairs[key]=Number(value);
 }
 return pairs;
}
function parseLimit(value){return value?.trim()==='max'?null:Number(value?.trim())||0}
export async function resourceHealth({root=ROOT,cgroupFile='/proc/self/cgroup'}={}){
 try{
  const value=await readFile(cgroupFile,'utf8');
  const match=value.split('\n').find(line=>line.startsWith('0::'));
  if(!match)return {available:false,reason:'cgroup v2 unavailable'};
  const logical=match.slice(3);
  const normalized=path.posix.normalize('/'+logical);
  const scope=path.join(root,normalized);
  if(!scope.startsWith(path.resolve(root)+path.sep)&&scope!==path.resolve(root))
   throw Error('Invalid cgroup hierarchy');
  const read=async filename=>{
   try{return (await readFile(path.join(scope,filename),'utf8')).trim()}
   catch(e){if(['ENOENT','EACCES'].includes(e.code))return null;throw e}
  };
  const [pCurrent,pPeak,pMax,pEvents,mCurrent,mPeak,mMax,mEvents]=await Promise.all(
    ['pids.current','pids.peak','pids.max','pids.events','memory.current','memory.peak','memory.max','memory.events'].map(read));
  const pids={current:Number(pCurrent)||0,peak:Number(pPeak)||0,max:parseLimit(pMax),
    events:parseEvents(pEvents||'')};
  const memory={current_bytes:Number(mCurrent)||0,peak_bytes:Number(mPeak)||0,max_bytes:parseLimit(mMax),
    events:parseEvents(mEvents||'')};
  const warnings=[];
  if(pids.max&&pids.current/pids.max>=.8)warnings.push('pids_at_least_80_percent');
  if(memory.max_bytes&&memory.current_bytes/memory.max_bytes>=.8)warnings.push('memory_at_least_80_percent');
  if(pids.max&&pids.peak>=pids.max)warnings.push('pids_limit_reached_in_history');
  if(memory.events.oom_kill)warnings.push('memory_oom_kills');
  return {available:true,cgroup:normalized,pids,memory,warnings,
    events_are_cumulative:true,sampled_at:new Date().toISOString()};
 }catch(e){return {available:false,reason:e.code||e.message}}
}
