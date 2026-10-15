// Runs under the same unprivileged execution identity as ordinary shell jobs.
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isInside } from './common.mjs';
import { editSuggestions } from './edit-diagnostics.mjs';

async function ensureDirectory(root, target) {
  if (!isInside(root, target)) throw new Error('Path escapes workspace');
  let current = root;
  for (const component of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try { await mkdir(current, { mode: 0o770 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Workspace write/mkdir paths cannot traverse symlinks or non-directories');
  }
}

async function copyOrMove(root, cwd, step) {
  const source=path.resolve(root,cwd,step.source);
  const destination=path.resolve(root,cwd,step.destination);
  if(!isInside(root,source)||!isInside(root,destination)||source===destination)
    throw new Error('Source and destination must be distinct workspace files');
  // Existing parents must not traverse symlinks. Only destination parents
  // can be created as a side effect of a successful file operation.
  let parent=root;
  for(const component of path.relative(root,path.dirname(source)).split(path.sep).filter(Boolean)){
    parent=path.join(parent,component);
    const info=await lstat(parent);
    if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Source path cannot traverse symlinks');
  }
  const sourceInfo=await lstat(source);
  if(!sourceInfo.isFile()||sourceInfo.isSymbolicLink()||sourceInfo.nlink!==1)
    throw new Error('Source must be a regular file with exactly one hard link');
  if(sourceInfo.size>128*1024*1024)throw new Error('Copy/move limit is 128 MiB; use an authorized job for larger files');
  await ensureDirectory(root,path.dirname(destination));
  // Refuse replacement even if the target is a dangling symlink.
  try { await lstat(destination); throw new Error('Destination already exists; copy/move never overwrites'); }
  catch(error){if(error.code!=='ENOENT')throw error;}
  const sourceFd=await open(source,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const temporary=path.join(path.dirname(destination),'.workspace-'+randomUUID()+'.tmp');
  let published=false;
  try{
    const stats=await sourceFd.stat();
    if(!stats.isFile()||stats.ino!==sourceInfo.ino||stats.dev!==sourceInfo.dev||stats.nlink!==1)
      throw new Error('Source changed while opening');
    const destFd=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,stats.mode&0o777);
    const hasher=createHash('sha256');
    try{
      let position=0;
      const block=Buffer.alloc(64*1024);
      while(position<stats.size){
        const {bytesRead}=await sourceFd.read(block,0,Math.min(block.length,stats.size-position),position);
        if(bytesRead===0)throw new Error('Source changed during copy');
        hasher.update(block.subarray(0,bytesRead));
        let written=0;
        while(written<bytesRead){
          const out=await destFd.write(block,written,bytesRead-written,position+written);
          if(!out.bytesWritten)throw new Error('Copy made no progress');
          written+=out.bytesWritten;
        }
        position+=bytesRead;
      }
    }finally{await destFd.close();}
    const after=await sourceFd.stat();
    if(after.size!==stats.size||after.mtimeMs!==stats.mtimeMs||after.ino!==stats.ino)
      throw new Error('Source changed during copy');
    const sha=hasher.digest('hex');
    if(sha!==step.expected_sha256)throw new Error('Source SHA-256 mismatch; destination not created');
    await link(temporary,destination);published=true;
    if(step.type==='move'){
      // The move is copy-then-unlink to support cross-volume workspaces.
      const current=await lstat(source);
      if(current.ino!==stats.ino||current.dev!==stats.dev||current.size!==stats.size||current.mtimeMs!==stats.mtimeMs)
        throw new Error('Source changed before move commit');
      await unlink(source);
    }
    return {ok:true,source:path.relative(root,source),destination:path.relative(root,destination),
      action:step.type,bytes:stats.size,sha256:sha};
  }catch(error){
    if(published){
      try{
        const tempInfo=await lstat(temporary);
        const destInfo=await lstat(destination);
        if(tempInfo.ino===destInfo.ino&&tempInfo.dev===destInfo.dev)
          await unlink(destination);
      }catch{ /* Preserve the original error; never delete a replacement file. */ }
    }
    throw error;
  }finally{await sourceFd.close();await rm(temporary,{force:true});}
}

async function boundedBody(response, maxBytes = 4096) {
  if (!response.body) return { body: '', body_truncated: false };
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0, truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - bytes;
      chunks.push(Buffer.from(value.subarray(0, remaining)));
      bytes += Math.min(value.length, remaining);
      if (value.length > remaining || bytes === maxBytes) { truncated = true; break; }
    }
  } finally { await reader.cancel().catch(() => {}); }
  return { body: Buffer.concat(chunks).toString('utf8'), body_truncated: truncated };
}

async function run({ workspace, cwd, step }) {
  if (step.type === 'http_check') {
    const deadline = Date.now() + step.timeout_seconds * 1000;
    let attempts = 0, status = null, body = '', body_truncated = false, error;
    do {
      attempts++;
      try {
        const response = await fetch(step.url, { method: step.method, redirect: 'manual', signal: AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now()))) });
        status = response.status;
        ({ body, body_truncated } = await boundedBody(response));
        error = undefined;
        if (status === step.expected_status) return { ok: true, status, attempts, body, body_truncated };
      } catch (cause) { error = cause.cause?.code || cause.name || 'HTTP request failed'; }
      if (Date.now() < deadline) await delay(Math.min(step.retry_interval_ms, deadline - Date.now()));
    } while (Date.now() < deadline);
    return { ok: false, status, expected_status: step.expected_status, attempts, body, body_truncated, error: error || `Expected HTTP ${step.expected_status}; received ${status}` };
  }
  const root = await realpath(workspace);
  if(step.type==='copy'||step.type==='move')return copyOrMove(root,cwd,step);
  const target = path.resolve(root, cwd, step.path);
  if (!isInside(root, target)) throw new Error('Path escapes workspace');
  if (step.type === 'mkdir') {
    await ensureDirectory(root, target);
    return { ok: true, path: path.relative(root, target) || '.' };
  }
  await ensureDirectory(root, path.dirname(target));
  let existing;
  try { existing = await lstat(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing && !existing.isFile()) throw new Error('Write target must be a regular file, not a symlink or directory');
  if (step.type === 'replace') {
    if (!existing || existing.isSymbolicLink()) throw new Error('replace target must be an existing regular file');
    if (existing.size > 8 * 1024 * 1024) throw new Error('replace target exceeds 8 MiB');
    const before = await readFile(target);
    const sha = createHash('sha256').update(before).digest('hex');
    if (sha !== step.expected_sha256) throw new Error('expected_sha256 mismatch; replace refused');
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(before);
    if (text.includes('\0')) throw new Error('replace does not support binary files');
    const first = text.indexOf(step.old_text);
    if (first < 0) return {
      ok:false,error:'replace old_text must have exactly one occurrence (found 0); no changes made',
      diagnostic:{type:'no_exact_match',suggestions:editSuggestions(text,step.old_text),
        next_step:'Read the suggested nearby lines, obtain a fresh SHA-256, then retry with exact text.'}
    };
    if (text.indexOf(step.old_text, first + 1) !== -1) return {
      ok:false,error:'replace old_text must have exactly one occurrence (found multiple); no changes made',
      diagnostic:{type:'ambiguous_match',first_line:1+(text.slice(0,first).match(/\n/g)||[]).length,
        next_step:'Include additional unique surrounding context and retry with a fresh SHA-256.'}
    };
    const next = text.slice(0,first) + step.new_text + text.slice(first + step.old_text.length);
    if (Buffer.byteLength(next) > 8 * 1024 * 1024) throw new Error('replace result exceeds 8 MiB');
    const tempfile = path.join(path.dirname(target), `.workspace-${randomUUID()}.tmp`);
    try {
      await writeFile(tempfile, next, { flag: 'wx', mode: existing.mode & 0o777 });
      // Recheck immediately before the atomic rename. flock serializes other
      // SuperChatDev writes; expected_sha256 guards the read version.
      if (createHash('sha256').update(await readFile(target)).digest('hex') !== sha)
        throw new Error('replace target changed before commit');
      await rename(tempfile,target);
    } finally { await rm(tempfile, { force: true }); }
    return { ok: true, path: path.relative(root,target), bytes: Buffer.byteLength(next),
             sha256: createHash('sha256').update(next).digest('hex'), replacements: 1 };
  }
  if(step.create_only && existing)throw new Error('create_only target already exists');
  if (step.expected_sha256) {
    if (!existing || createHash('sha256').update(await readFile(target)).digest('hex') !== step.expected_sha256) throw new Error('expected_sha256 mismatch; file was not overwritten');
  }
  const temporary = path.join(path.dirname(target), `.workspace-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, step.content, { flag: 'wx', mode: existing ? existing.mode & 0o777 : 0o660 });
    if(step.create_only)await link(temporary,target);
    else await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
  return { ok: true, path: path.relative(root, target), bytes: Buffer.byteLength(step.content), sha256: createHash('sha256').update(step.content).digest('hex') };
}

let result;
try {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 1024 * 1024) throw new Error('Step input exceeds 1 MiB'); chunks.push(chunk); }
  result = await run(JSON.parse(Buffer.concat(chunks).toString('utf8')));
} catch (error) { result = { ok: false, error: String(error.message).slice(0, 2048) }; }
await new Promise(resolve => process.stdout.write(JSON.stringify(result) + '\n', resolve));
process.exit(result.ok ? 0 : 1);
