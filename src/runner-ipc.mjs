// Bounded, private Unix socket transport for the opt-in isolated job runner.
import {connect} from 'node:net';
import path from 'node:path';
const MAX_REQUEST=64*1024,MAX_RESPONSE=160*1024;
export function runnerSocket(dataRoot){return path.join(dataRoot,'job-runner.sock');}

export function runnerRequest(socketPath,request,{timeoutMs=10000}={}){
 if(typeof socketPath!=='string'||!path.isAbsolute(socketPath))throw Error('Invalid runner socket path');
 const data=JSON.stringify(request);
 if(Buffer.byteLength(data)>MAX_REQUEST)throw Error('Runner request is too large');
 return new Promise((resolve,reject)=>{
  const socket=connect(socketPath);
  let done=false,size=0,parts=[];
  const finish=(error,value)=>{
   if(done)return;done=true;socket.destroy();
   if(error)reject(error);else resolve(value);
  };
  socket.setTimeout(timeoutMs,()=>finish(Error('Isolated job runner did not respond in time; inspect job state before retrying')));
  socket.once('error',e=>finish(Error('Isolated runner unavailable: '+e.code)));
  socket.once('connect',()=>socket.write(data+'\n'));
  socket.on('data',chunk=>{
   size+=chunk.length;
   if(size>MAX_RESPONSE){finish(Error('Isolated runner reply exceeds limit'));return}
   parts.push(chunk);
   const value=Buffer.concat(parts);
   const newline=value.indexOf(10);
   if(newline<0)return;
   let response;
   try{response=JSON.parse(value.subarray(0,newline).toString('utf8'))}
   catch{finish(Error('Invalid isolated runner JSON response'));return}
   if(response.ok!==true)finish(Error(response.error||'Isolated runner rejected launch'));
   else finish(null,response.result);
  });
  socket.once('end',()=>finish(Error('Isolated runner disconnected before acknowledging request')));
 });
}
