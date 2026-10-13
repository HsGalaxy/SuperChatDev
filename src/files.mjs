import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { atomicJSON, executionCommand, isInside, readJSON, requireInteger, scopedPath, toolResult } from './common.mjs';

export function publicIP(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)));
  }
  // Accept global-unicast IPv6 only, excluding IPv4 mappings and documentation ranges.
  return net.isIPv6(address) && /^[23]/.test(address) && !address.toLowerCase().startsWith('2001:db8:');
}

export function validateDownloadURL(value, allowedOrigins) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Expected an HTTPS download URL without credentials or fragment');
  // Explicit HTTPS wildcards permit subdomains only, with a DNS-label boundary
  // and the standard HTTPS port. DNS/IP validation still happens before download.
  const wildcardAllowed = !url.port && [...allowedOrigins].some(origin => {
    const suffix = origin.match(/^https:\/\/\*\.([a-z0-9]+(?:[.-][a-z0-9]+)*)$/i)?.[1].toLowerCase();
    return suffix && url.hostname.endsWith(`.${suffix}`);
  });
  if (!allowedOrigins.has(url.origin) && !wildcardAllowed) throw new Error(`Download origin is not allowed: ${url.origin}. Add the verified origin to FILE_DOWNLOAD_ORIGINS.`);
  return url;
}

export async function downloadFile(value, destination, { allowedOrigins, maxBytes, timeoutMs = 120000 }) {
  const url = validateDownloadURL(value, allowedOrigins);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const records = await lookup(hostname, { all: true, verbatim: true });
  if (!records.length || records.some(record => !publicIP(record.address))) throw new Error('Download URL resolves to a non-public address');
  const address = records[0];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let bytes = 0;
  try {
    const response = await new Promise((resolve, reject) => {
      const request = https.get(url, {
        signal: controller.signal,
        // Pin the validated DNS result; do not resolve again at connection time.
        lookup: (_host, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family)
      }, resolve);
      request.once('error', reject);
    });
    if (response.statusCode !== 200) {
      response.destroy();
      throw new Error(`File download failed with HTTP ${response.statusCode}; redirects are not followed`);
    }
    const declared = Number(response.headers['content-length']);
    if (declared > maxBytes) { response.destroy(); throw new Error('File exceeds the configured size limit'); }
    const limiter = new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > maxBytes ? new Error('File exceeds the configured size limit') : null, chunk);
    } });
    await pipeline(response, limiter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal: controller.signal });
    return bytes;
  } catch (error) {
    await rm(destination, { force: true });
    // Do not expose signed URLs/tokens in tool errors.
    if (error.code || error.name === 'AbortError') throw new Error(`File download failed: ${error.code || error.name}`);
    throw error;
  } finally { clearTimeout(timer); }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
  return n >>> 0;
});

async function storedZip(entries, destination, maxBytes) {
  const archive = await open(destination, 'wx', 0o600);
  let offset = 0;
  const central = [];
  const write = async buffer => {
    let done = 0;
    while (done < buffer.length) {
      const { bytesWritten } = await archive.write(buffer, done, buffer.length - done, offset);
      if (!bytesWritten) throw new Error('Unable to write archive');
      done += bytesWritten;
      offset += bytesWritten;
      if (offset > maxBytes || offset > 0xffffffff) throw new Error('Archive exceeds the configured size limit');
    }
  };
  try {
    for (const entry of entries) {
      const name = Buffer.from(entry.name, 'utf8');
      if (name.length > 65535) throw new Error('Archive filename is too long');
      const start = offset;
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0x0808, 6); // UTF-8 + trailing data descriptor.
      header.writeUInt16LE(0x0021, 12); // 1980-01-01, valid minimum DOS date.
      header.writeUInt16LE(name.length, 26);
      await write(header);
      await write(name);
      let size = 0;
      let crc = 0xffffffff;
      const file = await open(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const actual = await realpath(`/proc/self/fd/${file.fd}`);
        if (!isInside(entry.root, actual) || !(await file.stat()).isFile()) throw new Error('Archive file escaped the workspace');
        for await (const chunk of file.createReadStream({ autoClose: false })) {
          size += chunk.length;
          for (const byte of chunk) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
          await write(chunk);
        }
      } finally { await file.close(); }
      crc = (crc ^ 0xffffffff) >>> 0;
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(size, 8);
      descriptor.writeUInt32LE(size, 12);
      await write(descriptor);
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50);
      record.writeUInt16LE(20, 4);
      record.writeUInt16LE(20, 6);
      record.writeUInt16LE(0x0808, 8);
      record.writeUInt16LE(0x0021, 14);
      record.writeUInt32LE(crc, 16);
      record.writeUInt32LE(size, 20);
      record.writeUInt32LE(size, 24);
      record.writeUInt16LE(name.length, 28);
      record.writeUInt32LE(start, 42);
      central.push(record, name);
    }
    const centralOffset = offset;
    for (const record of central) await write(record);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(offset - centralOffset, 12);
    end.writeUInt32LE(centralOffset, 16);
    await write(end);
  } finally { await archive.close(); }
}

export class Files {
  constructor({ workspace, dataRoot, publicBaseURL = '', allowedOrigins = [], maxFileBytes = 512 * 1024 * 1024, maxResourceBytes = 8 * 1024 * 1024, download = downloadFile, executionUid, executionGid }) {
    Object.assign(this, { workspace, dataRoot, publicBaseURL, maxFileBytes, maxResourceBytes, download });
    this.allowedOrigins = new Set(allowedOrigins);
    this.artifactRoot = path.join(dataRoot, 'artifacts');
    this.executionIdentity = executionUid !== undefined ? { uid: executionUid, gid: executionGid } : {};
  }

  async init() {
    await mkdir(this.artifactRoot, { recursive: true, mode: 0o700 });
    const keyFile = path.join(this.dataRoot, 'download-key');
    try { await writeFile(keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    this.key = await readFile(keyFile);
  }

  async importFile({ file }) {
    if (!file || typeof file.download_url !== 'string' || typeof file.file_id !== 'string') throw new Error('Expected a ChatGPT file parameter containing download_url and file_id');
    const originalName = typeof file.file_name === 'string' ? path.basename(file.file_name.replaceAll('\\', '/')) : 'attachment.bin';
    const safeName = originalName.replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 120) || 'attachment.bin';
    const dir = path.join(this.workspace, 'imports');
    await mkdir(dir, { recursive: true, mode: 0o770 });
    await scopedPath(this.workspace, 'imports');
    const destination = path.join(dir, `${randomUUID()}-${safeName}`);
    const temporary = `${destination}.part`;
    let bytes;
    try {
      bytes = await this.download(file.download_url, temporary, { allowedOrigins: this.allowedOrigins, maxBytes: this.maxFileBytes });
      if ((await stat(temporary)).size > this.maxFileBytes) throw new Error('File exceeds size limit');
      await rename(temporary, destination);
      const { chmod } = await import('node:fs/promises');
      await chmod(destination, 0o660);
    } catch (error) { await rm(temporary, { force: true }); throw error; }
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(destination)) hash.update(chunk);
    return { path: path.relative(this.workspace, destination), bytes, sha256: hash.digest('hex'), file_id: file.file_id, original_name: originalName, mime_type: file.mime_type ?? null };
  }

  async exportFile({ path: relative = '.', exclude = ['.git', 'node_modules', '.chatgpt-mcp', '.env'], ttl_seconds }) {
    if (!Array.isArray(exclude) || exclude.some(name => typeof name !== 'string' || name.includes('/'))) throw new Error('exclude must be an array of directory/file basenames');
    const ttl = requireInteger(ttl_seconds, 900, 60, 86400, 'ttl_seconds');
    const source = await scopedPath(this.workspace, relative);
    if (isInside(this.dataRoot, source)) throw new Error('Cannot export internal MCP state');
    const info = await stat(source);
    const id = randomUUID();
    const dir = path.join(this.artifactRoot, id);
    await mkdir(dir, { mode: 0o700 });
    const destination = path.join(dir, 'data');
    let name;
    let mimeType;
    try {
      if (info.isDirectory()) {
        const entries = [];
        const walk = async directory => {
          for (const item of await readdir(directory, { withFileTypes: true })) {
            if (exclude.includes(item.name)) continue;
            const filename = path.join(directory, item.name);
            const resolved = await realpath(filename);
            if (isInside(this.dataRoot, resolved)) continue;
            if (!isInside(this.workspace, resolved) || item.isSymbolicLink()) throw new Error('Directory export rejects symbolic links');
            if (item.isDirectory()) await walk(filename);
            else if (item.isFile()) {
              if (entries.length >= 10000) throw new Error('Too many files in export');
              entries.push({ path: filename, name: path.relative(source, filename).split(path.sep).join('/'), root: this.workspace });
            }
          }
        };
        await walk(source);
        await storedZip(entries, destination, this.maxFileBytes);
        name = `${path.basename(source)}.zip`;
        mimeType = 'application/zip';
      } else if (info.isFile()) {
        if (info.size > this.maxFileBytes) throw new Error('File exceeds size limit');
        await this.copyBounded(source, destination);
        name = path.basename(source);
        mimeType = ({ '.zip': 'application/zip', '.png': 'image/png', '.pdf': 'application/pdf', '.txt': 'text/plain', '.json': 'application/json' })[path.extname(name).toLowerCase()] || 'application/octet-stream';
      } else throw new Error('Only regular files and directories can be exported');
      const metadata = { id, name, mimeType, bytes: (await stat(destination)).size, created_at: new Date().toISOString() };
      await atomicJSON(path.join(dir, 'meta.json'), metadata);
      const expires = Math.floor(Date.now() / 1000) + ttl;
      const token = this.sign(id, expires);
      const uri = `artifact://${id}/${encodeURIComponent(name)}`;
      const result = { ...metadata, resource_uri: uri, expires_at: new Date(expires * 1000).toISOString(), resource_read_available: metadata.bytes <= this.maxResourceBytes };
      if (this.publicBaseURL) result.download_url = `${this.publicBaseURL}/artifacts/${id}?expires=${expires}&token=${token}`;
      return toolResult(result, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }, { type: 'resource_link', uri, name, mimeType, size: metadata.bytes }, ...(result.download_url ? [{ type: 'resource_link', uri: result.download_url, name, mimeType, size: metadata.bytes }] : [])] });
    } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
  }

  async unpack({ path: relative }) {
    const source = await scopedPath(this.workspace, relative, { allowRoot: false });
    if (!(await stat(source)).isFile()) throw new Error('Expected a ZIP file');
    const root = path.join(this.workspace, 'imports');
    await mkdir(root, { recursive: true, mode: 0o770 });
    await scopedPath(this.workspace, 'imports');
    const target = path.join(root, `project-${randomUUID()}`);
    const [executable, argv] = executionCommand(['python3', fileURLToPath(new URL('./unpack.py', import.meta.url)), source, target, String(this.maxFileBytes)], this.executionIdentity.uid !== undefined);
    const worker = spawn(executable, argv, { ...this.executionIdentity, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, LANG: 'C.UTF-8' } });
    let output = '';
    worker.stdout.on('data', chunk => { output += chunk; });
    worker.stderr.resume();
    const timer = setTimeout(() => worker.kill('SIGKILL'), 120000);
    try {
      const code = await new Promise((resolve, reject) => { worker.once('error', reject); worker.once('exit', resolve); });
      if (code !== 0) {
        let message = 'ZIP extraction failed or timed out (Python 3 is required)';
        try { message = JSON.parse(output).error || message; } catch {}
        throw new Error(message);
      }
      return { path: path.relative(this.workspace, target), ...JSON.parse(output) };
    } catch (error) { await rm(target, { recursive: true, force: true }); throw error; }
    finally { clearTimeout(timer); }
  }

  async copyBounded(source, destination) {
    let bytes = 0;
    const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!isInside(this.workspace, await realpath(`/proc/self/fd/${file.fd}`))) throw new Error('File escaped the workspace');
      await pipeline(file.createReadStream({ autoClose: false }), new Transform({ transform: (chunk, _encoding, callback) => {
        bytes += chunk.length;
        callback(bytes > this.maxFileBytes ? new Error('File exceeds size limit') : null, chunk);
      } }), createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
    } finally { await file.close(); }
  }

  sign(id, expires) { return createHmac('sha256', this.key).update(`${id}.${expires}`).digest('base64url'); }

  async artifact(id) {
    if (!/^[0-9a-f-]{36}$/.test(id ?? '')) throw new Error('Invalid artifact ID');
    const dir = path.join(this.artifactRoot, id);
    return { ...(await readJSON(path.join(dir, 'meta.json'))), filename: path.join(dir, 'data') };
  }

  async downloadArtifact(id, expires, token) {
    if (!/^\d+$/.test(expires ?? '') || Number(expires) < Math.floor(Date.now() / 1000)) throw new Error('Download link expired');
    const expected = Buffer.from(this.sign(id, expires));
    const supplied = Buffer.from(token || '');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new Error('Invalid download token');
    return this.artifact(id);
  }

  async readResource(uri) {
    const url = new URL(uri);
    if (url.protocol !== 'artifact:') throw new Error('Unknown resource URI');
    const artifact = await this.artifact(url.hostname);
    if (uri !== `artifact://${artifact.id}/${encodeURIComponent(artifact.name)}`) throw new Error('Unknown resource URI');
    if (artifact.bytes > this.maxResourceBytes) throw new Error('Artifact is too large for resources/read; use its HTTPS download link');
    return { contents: [{ uri, mimeType: artifact.mimeType, blob: (await readFile(artifact.filename)).toString('base64') }] };
  }

  async listResources() {
    const ids = (await readdir(this.artifactRoot)).filter(id => /^[0-9a-f-]{36}$/.test(id));
    const artifacts = await Promise.all(ids.map(id => this.artifact(id)));
    return { resources: artifacts.map(({ id, name, mimeType, bytes }) => ({ uri: `artifact://${id}/${encodeURIComponent(name)}`, name, mimeType, size: bytes })) };
  }
}

export const fileTools = [
  {
    name: 'file_import', title: 'Import a ChatGPT attachment',
    description: 'Download the original bytes of a user attachment into workspace/imports. Use the ChatGPT file parameter, never invent download URLs, internal paths or Base64. Returns a workspace-relative path, byte count and SHA-256. Archives are saved without automatic extraction.',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'object', properties: { download_url: { type: 'string' }, file_id: { type: 'string' }, mime_type: { type: 'string' }, file_name: { type: 'string' } }, required: ['download_url', 'file_id'], additionalProperties: false } },
      required: ['file'], additionalProperties: false
    },
    _meta: { 'openai/fileParams': ['file'] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  },
  {
    name: 'file_unpack', title: 'Safely unpack a project ZIP',
    description: 'Extract a workspace ZIP into a new private imports/project-ID directory. Reject path traversal, links, encrypted entries, duplicate paths and excessive expansion. Returns the project directory. Requires Python 3.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'file_export', title: 'Export a workspace file or project',
    description: 'Snapshot a workspace file, or package a directory as a ZIP. Return a signed HTTPS download link and a registered MCP artifact resource. Directory defaults exclude .git, node_modules, .chatgpt-mcp and .env; symbolic links are rejected. Native ChatGPT attachment rendering is client-dependent.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', default: '.' }, exclude: { type: 'array', items: { type: 'string' } }, ttl_seconds: { type: 'integer', minimum: 60, maximum: 86400 } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }
];
