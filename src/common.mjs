import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function scopedPath(root, relative = '.', { allowRoot = true } = {}) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) throw new Error('Use a workspace-relative path');
  const target = path.resolve(root, relative);
  if (!isInside(root, target)) throw new Error('Path escapes the workspace');
  const resolved = await realpath(target);
  if (!isInside(root, resolved) || (!allowRoot && resolved === root)) throw new Error('Path escapes the workspace');
  return resolved;
}

export async function atomicJSON(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, filename);
}

export async function readJSON(filename) {
  return JSON.parse(await readFile(filename, 'utf8'));
}

export function toolResult(value, extra = {}) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value, ...extra };
}

export function requireInteger(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

export function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function executionCommand(argv, isolated) {
  // Changing UID alone does not clear ambient capabilities. Remove inherited and
  // ambient capabilities before exec so untrusted programs cannot switch UIDs.
  return isolated ? ['/usr/bin/setpriv', ['--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs', '--', ...argv]] : [argv[0], argv.slice(1)];
}
