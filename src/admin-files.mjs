import { randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { lstat, readdir, mkdir, open, rename, rm, rmdir, stat, unlink, writeFile, link } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// File manager is deliberately confined to WORKSPACE_ROOT. Any symlink in a
// traversed path is refused, including symlinks pointing back into the tree.
export class AdminFiles {
  constructor(workspace) { this.root = workspace; this.maxTextBytes = 1024 * 1024; this.maxUploadBytes = 32 * 1024 * 1024; }
  parts(input = '.') {
    if (typeof input !== 'string' || input.length > 2048 || input.includes('\0') ||
        input.startsWith('/') || input.includes('\\')) throw new Error('Invalid workspace-relative path');
    const parts = input.split('/').filter(x => x !== '' && x !== '.');
    if (parts.some(x => x === '..' || x.length > 255)) throw new Error('Path traversal is not allowed');
    return parts;
  }
  async walk(input = '.', { missing = false, allowRoot = true } = {}) {
    const parts = this.parts(input);
    if (!allowRoot && !parts.length) throw new Error('The workspace root cannot be modified');
    let current = this.root;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      let info;
      try { info = await lstat(current); }
      catch (error) {
        if (error.code === 'ENOENT' && missing && i === parts.length - 1) return { full: current, exists: false };
        throw error;
      }
      if (info.isSymbolicLink()) throw new Error('Symbolic links cannot be followed');
      if (i < parts.length - 1 && !info.isDirectory()) throw new Error('Parent must be a directory');
    }
    return { full: current, exists: true, info: await lstat(current) };
  }
  async directory(relative) {
    const target = await this.walk(relative);
    if (!target.info.isDirectory()) throw new Error('Not a directory');
    return target;
  }
  async list(relative = '.') {
    const target = await this.directory(relative);
    const entries = await Promise.all((await readdir(target.full, { withFileTypes: true })).slice(0, 1000).map(async item => {
      const meta = await lstat(path.join(target.full, item.name));
      return { name: item.name, type: meta.isSymbolicLink() ? 'link' : meta.isDirectory() ? 'directory' : meta.isFile() ? 'file' : 'other',
        bytes: meta.size, modified_at: meta.mtime.toISOString() };
    }));
    entries.sort((a, b) => (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1) || a.name.localeCompare(b.name));
    return { path: this.parts(relative).join('/'), entries, truncated: entries.length >= 1000 };
  }
  async reader(relative, maxBytes = this.maxTextBytes) {
    const target = await this.walk(relative, { allowRoot: false });
    if (!target.info.isFile() || target.info.size > maxBytes) throw new Error('File is not a regular file or exceeds the size limit');
    const file = await open(target.full, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!(await file.stat()).isFile()) { await file.close(); throw new Error('Not a regular file'); }
    return { file, size: target.info.size, name: path.basename(target.full) };
  }
  async text(relative) {
    const { file } = await this.reader(relative);
    try {
      const data = await file.readFile();
      // Reject embedded NUL; keep editor strictly for UTF-8 text.
      if (data.includes(0) || !new TextDecoder('utf-8', { fatal: true }).decode(data)) {
        if (data.length) throw new Error('Binary or non-UTF-8 file: download instead');
      }
      return { path: relative, content: data.toString('utf8') };
    } finally { await file.close(); }
  }
  async save(relative, content) {
    if (typeof content !== 'string' || Buffer.byteLength(content) > this.maxTextBytes) throw new Error('Text file exceeds 1 MiB');
    const target = await this.walk(relative, { allowRoot: false, missing: true });
    if (target.exists && !target.info.isFile()) throw new Error('Only regular files may be replaced');
    const temp = path.join(path.dirname(target.full), '.admin-' + randomUUID() + '.tmp');
    try { await writeFile(temp, content, { flag: 'wx', mode: 0o660 }); await rename(temp, target.full); }
    finally { await rm(temp, { force: true }); }
    return { ok: true, path: relative };
  }
  async createDirectory(relative) {
    const target = await this.walk(relative, { allowRoot: false, missing: true });
    if (target.exists) throw new Error('Path already exists');
    await mkdir(target.full, { mode: 0o770 });
    return { ok: true };
  }
  async move(from, to) {
    const source = await this.walk(from, { allowRoot: false });
    const destination = await this.walk(to, { allowRoot: false, missing: true });
    if (destination.exists) throw new Error('Destination already exists');
    if (source.info.isDirectory() && (destination.full + path.sep).startsWith(source.full + path.sep)) throw new Error('Cannot move a folder inside itself');
    await rename(source.full, destination.full);
    return { ok: true };
  }
  async remove(relative) {
    const target = await this.walk(relative, { allowRoot: false });
    if (target.info.isDirectory()) await rmdir(target.full);
    else if (target.info.isFile()) await unlink(target.full);
    else throw new Error('Cannot remove a symbolic link or special file');
    return { ok: true };
  }
  async upload(relative, request, maxBytes = this.maxUploadBytes) {
    const target = await this.walk(relative, { missing: true, allowRoot: false });
    if (target.exists) throw new Error('File already exists');
    const tmp = path.join(path.dirname(target.full), '.admin-upload-' + randomUUID());
    let bytes = 0;
    const limiter = new Transform({ transform(chunk, _encoding, next) {
      bytes += chunk.length;
      next(bytes > maxBytes ? new Error('Upload exceeds size limit') : null, chunk);
    } });
    try {
      await pipeline(request, limiter, createWriteStream(tmp, { flags: 'wx', mode: 0o660 }));
      // Hard link ensures that racing file creations are never overwritten.
      await link(tmp, target.full);
      return { ok: true, bytes, path: relative };
    } finally { await rm(tmp, { force: true }); }
  }
}
