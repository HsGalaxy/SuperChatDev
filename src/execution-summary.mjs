// Execution outcomes are not MCP transport statuses. Key by durable IDs,
// and do not double-count batch children already represented by the batch.
const STATES=['succeeded','failed','interrupted','cancelled','running','queued'];
const normalize=value=>STATES.includes(value)?value:'unknown';
export function summarizeExecutions(jobs=[],batches=[],opts={}){
 const jobMap=new Map(jobs.map(x=>[x.id,x]).filter(([id])=>typeof id==='string'));
 const batchMap=new Map(batches.map(x=>[x.execution_id,x]).filter(([id])=>typeof id==='string'));
 const totals=Object.fromEntries([...STATES,'unknown'].map(s=>[s,0]));
 const kinds={standalone_jobs:0,batches:0,excluded_batch_child_jobs:0};
 for(const job of jobMap.values()){
  if(job.batch_execution_id){
   kinds.excluded_batch_child_jobs++;
   continue;
  }
  totals[normalize(job.status)]++;
  kinds.standalone_jobs++;
 }
 for(const batch of batchMap.values()){
  totals[normalize(batch.status)]++;
  kinds.batches++;
 }
 const finished=totals.succeeded+totals.failed+totals.cancelled+totals.interrupted;
 return {states:totals,kinds,terminal_total:finished,
  execution_success_rate:finished?Math.round(10000*totals.succeeded/finished)/100:null,
  sampled_jobs:jobMap.size,sampled_batches:batchMap.size,
  may_be_partial:opts.may_be_partial===true,
  note:'Execution outcome counted once per durable job/batch ID. Job children of batches are excluded. Tool HTTP success is a separate metric.'};
}
