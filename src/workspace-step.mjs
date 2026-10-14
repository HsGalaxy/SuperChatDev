// Runs under the same unprivileged execution identity as ordinary shell jobs.
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isInside } from './common.mjs';

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
    if (first < 0 || text.indexOf(step.old_text, first + 1) !== -1)
      throw new Error('replace old_text must have exactly one occurrence');
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
