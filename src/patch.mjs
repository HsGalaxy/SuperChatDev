import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isInside } from './common.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const linesOf = text => text.match(/[^\n]*\n|[^\n]+$/g) || [];

export function parsePatch(diff) {
  if (typeof diff !== 'string' || !diff || Buffer.byteLength(diff) > 768 * 1024) throw new Error('patch requires a nonempty unified diff within 768 KiB');
  const lines = linesOf(diff), files = [];
  let i = 0;
  const headerPath = (line, prefix) => {
    let value = line.slice(prefix.length).replace(/\n$/, '');
    if (value === '/dev/null') return null;
    if (value.startsWith('a/') || value.startsWith('b/')) value = value.slice(2);
    if (!value || /[\0\r\t]/.test(value) || path.isAbsolute(value) || value.split('/').some(c => !c || c === '.' || c === '..')) throw new Error('Patch paths must be plain relative paths without traversal or timestamps');
    return value;
  };
  while (i < lines.length) {
    // Standard git diff metadata is accepted; binary, renames and mode-only
    // patches without ---/+++ content are deliberately unsupported.
    while (i < lines.length && /^(diff --git |index |new file mode |deleted file mode )/.test(lines[i])) i++;
    if (!lines[i]?.startsWith('--- ') || !lines[i + 1]?.startsWith('+++ ')) throw new Error('Expected unified diff --- and +++ file headers');
    const before = headerPath(lines[i++], '--- '), after = headerPath(lines[i++], '+++ ');
    if ((!before && !after) || (before && after && before !== after)) throw new Error('Patch renames are unsupported');
    const file = { path: before || after, create: before === null, remove: after === null, hunks: [] };
    while (i < lines.length && lines[i].startsWith('@@ ')) {
      const match = lines[i++].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@[^\n]*\n?$/);
      if (!match) throw new Error('Invalid unified diff hunk header');
      const [oldStart, oldCount, newStart, newCount] = [Number(match[1]), Number(match[2] ?? 1), Number(match[3]), Number(match[4] ?? 1)];
      if (![oldStart, oldCount, newStart, newCount].every(Number.isSafeInteger) || (oldCount && !oldStart) || (newCount && !newStart)) throw new Error('Invalid hunk coordinates');
      const hunk = { oldStart, oldCount, newStart, newCount, old: [], next: [] };
      let previous;
      while (i < lines.length && !lines[i].startsWith('@@ ') &&
             !lines[i].startsWith('--- ') && !lines[i].startsWith('diff --git ')) {
        const line = lines[i++];
        if (![' ', '+', '-'].includes(line[0])) throw new Error('Invalid patch hunk content');
        previous = line[0];
        if (previous !== '+') hunk.old.push(line.slice(1));
        if (previous !== '-') hunk.next.push(line.slice(1));
        if (lines[i]?.startsWith('\\ No newline at end of file')) {
          i++;
          if (previous !== '+') hunk.old[hunk.old.length - 1] = hunk.old.at(-1).replace(/\n$/, '');
          if (previous !== '-') hunk.next[hunk.next.length - 1] = hunk.next.at(-1).replace(/\n$/, '');
        }
      }
      if (Math.abs(hunk.old.length - oldCount) > 3 || Math.abs(hunk.next.length - newCount) > 3)
        throw new Error('Hunk line counts differ too much from header');
      hunk.oldCount = hunk.old.length;
      hunk.newCount = hunk.next.length;
      file.hunks.push(hunk);
    }
    if (!file.hunks.length) throw new Error('A patch file requires at least one hunk');
    if (files.some(f => f.path === file.path)) throw new Error('A patch cannot list the same file twice');
    files.push(file);
    if (files.length > 32) throw new Error('Patch exceeds 32 files');
  }
  return files;
}

export function applyHunks(original, file) {
  const source = linesOf(original), output = [];
  let consumed = 0;
  for (const hunk of file.hunks) {
    const expected = hunk.oldCount ? hunk.oldStart - 1 : hunk.oldStart;
    const oldText = hunk.old.join('');
    const matchesAt = pos => pos >= consumed && pos <= source.length &&
      pos + hunk.oldCount <= source.length &&
      source.slice(pos, pos + hunk.oldCount).join('') === oldText;
    let offset = expected;
    if (!matchesAt(offset)) {
      if (!hunk.oldCount) throw new Error('Ambiguous zero-context insertion: use exact coordinates');
      const positions = [];
      for (let pos = Math.max(consumed, expected - 20);
           pos <= Math.min(source.length - hunk.oldCount, expected + 20); pos++) {
        if (matchesAt(pos)) positions.push(pos);
      }
      if (positions.length !== 1)
        throw new Error('Exact hunk context/line mismatch; unique patch context not found within 20 lines: ' + file.path + ' (matches=' + positions.length + ')');
      offset = positions[0];
    }
    output.push(...source.slice(consumed, offset), ...hunk.next);
    consumed = offset + hunk.oldCount;
  }
  output.push(...source.slice(consumed));
  return output.join('');
}

async function checkedParent(root, target) {
  let current = root;
  for (const part of path.relative(root, path.dirname(target)).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let info;
    try { info = await lstat(current); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Patch paths cannot traverse symlinks or non-directories');
  }
}

export async function applyPatch({ workspace, cwd, step }) {
  const root = await realpath(workspace), project = path.resolve(root, cwd);
  if (!isInside(root, project)) throw new Error('Patch cwd escapes workspace');
  const files = parsePatch(step.patch), prepared = [];
  // Validate every file and all hunks before staging or modifying any target.
  for (const file of files) {
    const target = path.resolve(project, file.path);
    if (!isInside(root, target) || !isInside(project, target)) throw new Error('Patch path escapes project');
    await checkedParent(root, target);
    let info, bytes = Buffer.alloc(0);
    try { info = await lstat(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error('Patch targets must be regular files');
    if (file.create ? info : !info) throw new Error(`Patch ${file.create ? 'create target exists' : 'target missing'}: ${file.path}`);
    if (info) { if (info.size > 8 * 1024 * 1024) throw new Error('Patch file exceeds 8 MiB'); bytes = await readFile(target); }
    const expected = Object.hasOwn(step.expected_sha256 || {}, file.path) ? step.expected_sha256[file.path] : undefined;
    if (expected && hash(bytes) !== expected) throw new Error(`expected_sha256 mismatch: ${file.path}`);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.includes('\0')) throw new Error('Binary patches are unsupported');
    const next = applyHunks(text, file);
    if (file.remove && next !== '') throw new Error('Delete patch must remove the complete file');
    if (Buffer.byteLength(next) > 8 * 1024 * 1024) throw new Error('Patched file exceeds 8 MiB');
    prepared.push({ file, target, bytes, next, mode: info ? info.mode & 0o777 : 0o660 });
  }
  const guardKeys = Object.keys(step.expected_sha256 || {});
  if (guardKeys.some(key => !files.some(f => f.path === key))) throw new Error('Hash guard refers to a file outside the patch');
  const staged = [], applied = [];
  try {
    for (const item of prepared) {
      await mkdir(path.dirname(item.target), { recursive: true, mode: 0o770 });
      await checkedParent(root, item.target);
      const temporary = path.join(path.dirname(item.target), `.patch-${randomUUID()}.tmp`);
      staged.push(temporary); item.temporary = temporary;
      await writeFile(temporary, item.next, { flag: 'wx', mode: item.mode });
    }
    for (const item of prepared) {
      await checkedParent(root, item.target);
      let current;
      try { const info = await lstat(item.target); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Patch target changed type'); current = await readFile(item.target); }
      catch (error) { if (error.code !== 'ENOENT' || !item.file.create) throw error; }
      if (item.file.create ? current !== undefined : !current?.equals(item.bytes)) throw new Error('File changed during patch; refusing overwrite');
      if (item.file.remove) await rm(item.target); else await rename(item.temporary, item.target);
      applied.push(item);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const item of applied.reverse()) {
      try {
        await checkedParent(root, item.target);
        // Do not overwrite edits from an unrelated concurrent command.
        let current;
        try { const info = await lstat(item.target); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Rollback target changed type'); current = await readFile(item.target); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
        if (item.file.remove ? current !== undefined : !current?.equals(Buffer.from(item.next))) throw new Error('Concurrent change prevents rollback');
        if (item.file.create) await rm(item.target);
        else { const restore = path.join(path.dirname(item.target), `.patch-${randomUUID()}.tmp`); staged.push(restore); await writeFile(restore, item.bytes, { flag: 'wx', mode: item.mode }); await rename(restore, item.target); }
      } catch (cause) { rollbackErrors.push(`${item.file.path}: ${cause.message}`); }
    }
    if (rollbackErrors.length) throw new Error(`${error.message}; rollback incomplete: ${rollbackErrors.join('; ')}`);
    throw error;
  } finally { await Promise.all(staged.map(file => rm(file, { force: true }))); }
  return { ok: true, files: prepared.map(({ file, next }) => ({ path: file.path, action: file.create ? 'created' : file.remove ? 'deleted' : 'updated', sha256: file.remove ? null : hash(next), bytes: Buffer.byteLength(next) })),
    guarantees: 'All files preflighted; unique exact context required for bounded relocation; each replacement atomic; ordinary commit failures attempt rollback. Multi-file commits are not crash-atomic. Do not run concurrent edits on these files.' };
}
