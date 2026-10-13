import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { applyPatch, parsePatch } from '../src/patch.mjs';
import { clarifyProcessResult } from '../src/process-status.mjs';
import { createApp } from '../src/server.mjs';
import { validatePlan } from '../src/workspace.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-improvements-'));
  const workspace = path.join(root, 'workspace'), dataRoot = path.join(root, 'state');
  await mkdir(workspace); await mkdir(dataRoot);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, workspace, dataRoot, bearerToken: 'test-token', httpOrigins: [], executionEnv: { TOOLCHAIN_TEST: 'preset-value' } };
}

test('patch anchors repeated text and supports UTF-8, adds, deletes and no final newline', async t => {
  const { workspace } = await fixture(t);
  await writeFile(path.join(workspace, 'repeat.txt'), 'same\nsame\nsame\n');
  await writeFile(path.join(workspace, 'delete.txt'), 'gone\n');
  await writeFile(path.join(workspace, 'unicode.txt'), '你好');
  const patch = '--- a/repeat.txt\n+++ b/repeat.txt\n@@ -2 +2 @@\n-same\n+edited\n' +
    '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+created\n' +
    '--- a/delete.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n' +
    '--- a/unicode.txt\n+++ b/unicode.txt\n@@ -1 +1 @@\n-你好\n\\ No newline at end of file\n+世界\n\\ No newline at end of file\n';
  const result = await applyPatch({ workspace, cwd: '.', step: { patch } });
  assert.equal(result.ok, true);
  assert.equal(await readFile(path.join(workspace, 'repeat.txt'), 'utf8'), 'same\nedited\nsame\n');
  assert.equal(await readFile(path.join(workspace, 'unicode.txt'), 'utf8'), '世界');
  assert.equal(await readFile(path.join(workspace, 'new.txt'), 'utf8'), 'created\n');
  await assert.rejects(readFile(path.join(workspace, 'delete.txt')), { code: 'ENOENT' });
});

test('a bad later file rejects entire patch; path, symlink and stale hash guards protect writes', async t => {
  const { workspace, root } = await fixture(t);
  await writeFile(path.join(workspace, 'one'), 'one\n');
  await writeFile(path.join(workspace, 'two'), 'two\n');
  const first = '--- a/one\n+++ b/one\n@@ -1 +1 @@\n-one\n+new\n';
  await assert.rejects(applyPatch({ workspace, cwd: '.', step: { patch: first + '--- a/two\n+++ b/two\n@@ -1 +1 @@\n-wrong\n+new\n' } }), /context\/line mismatch/);
  assert.equal(await readFile(path.join(workspace, 'one'), 'utf8'), 'one\n');
  await assert.rejects(applyPatch({ workspace, cwd: '.', step: { patch: first, expected_sha256: { one: '0'.repeat(64) } } }), /sha256 mismatch/);
  await symlink(root, path.join(workspace, 'link'));
  await assert.rejects(applyPatch({ workspace, cwd: '.', step: { patch: '--- /dev/null\n+++ b/link/escape\n@@ -0,0 +1 @@\n+no\n' } }), /symlink/);
  assert.throws(() => parsePatch('--- /dev/null\n+++ b/../escape\n@@ -0,0 +1 @@\n+no\n'), /traversal/);
  const insertion = '--- a/one\n+++ b/one\n@@ -1,0 +2 @@\n+after\n';
  await applyPatch({ workspace, cwd: '.', step: { patch: insertion } });
  assert.equal(await readFile(path.join(workspace, 'one'), 'utf8'), 'one\nafter\n');
});

test('gateway traces link detached batch jobs, persist across restart and omit source/secrets', async t => {
  const config = await fixture(t);
  const app = await createApp(config);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}/mcp`;
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const call = async (name, args) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const value = await res.json();
    assert.ok(!value.error, JSON.stringify(value));
    return value.result;
  };
  const execution = await call('workspace_execute', { wait_ms: 10000, steps: [
    { type: 'write', path: 'private.txt', content: 'private-source-not-for-trace' },
    { type: 'patch', patch: '--- a/private.txt\n+++ b/private.txt\n@@ -1 +1 @@\n-private-source-not-for-trace\n\\ No newline at end of file\n+replacement\n' },
    { type: 'exec', command: 'printf "%s\\n" "$TOOLCHAIN_TEST"', env: { PRIVATE_TEST: 'secret-not-for-trace' } }
  ] });
  assert.equal(execution.structuredContent.status, 'succeeded', JSON.stringify(execution));
  const trace_id = execution.structuredContent.trace_id;
  assert.equal(execution.structuredContent.steps[2].result.output, 'preset-value\n');
  const guide = (await call('dev_get_guide', { trace_id })).structuredContent;
  assert.equal(guide.diagnostics.calls[0].trace_id, trace_id);
  assert.equal(guide.diagnostics.jobs.length, 3);
  assert.ok(guide.diagnostics.jobs.every(job => job.trace_id === trace_id));
  assert.equal(guide.diagnostics.executions[0].trace_id, trace_id);
  const app2 = await createApp(config);
  const traceFiles = await readdir(path.join(config.dataRoot, 'traces'));
  const persisted = (await Promise.all(traceFiles.map(name => readFile(path.join(config.dataRoot, 'traces', name), 'utf8')))).join('\n');
  assert.ok(persisted.includes(trace_id));
  assert.ok(!persisted.includes('private-source-not-for-trace'));
  assert.ok(!persisted.includes('secret-not-for-trace'));
  assert.ok(!persisted.includes('printf'));
  app2.server.close();
});

test('REPL wait expiration is distinguished from execution failure and checked against active sessions', async () => {
  const original = { content: [{ type: 'text', text: '42\n⏱️ Response may be incomplete (timeout reached)' }] };
  const result = await clarifyProcessResult('interact_with_process', { pid: 123 }, original, { request: async () => ({ content: [{ type: 'text', text: 'PID: 123, Blocked: false, Runtime: 2s' }] }) });
  assert.equal(result.structuredContent.process_status.session_active, true);
  assert.equal(result.structuredContent.process_status.execution_outcome, 'unknown');
  assert.match(result.content[0].text, /not an execution timeout/);
  assert.match(result.content[0].text, /42/);
  const failed = { isError: true, content: [{ type: 'text', text: 'real error' }] };
  assert.equal(await clarifyProcessResult('interact_with_process', {}, failed, {}), failed);
});

test('container step rejects host networking and defaults to a bounded, offline build', () => {
  const plan = validatePlan({ steps: [{ type: 'container_build' }] });
  assert.equal(plan.steps[0].network, 'none');
  assert.equal(plan.steps[0].timeout_seconds, 600);
  assert.throws(() => validatePlan({ steps: [{ type: 'container_build', network: 'host' }] }), /none or private/);
  assert.throws(() => validatePlan({ steps: [{ type: 'container_build', dockerfile: '/etc/passwd' }] }), /relative/);
});
