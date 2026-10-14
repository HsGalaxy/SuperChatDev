import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Jobs, processIdentity } from '../src/jobs.mjs';
import { Workspace, batchTerminal } from '../src/workspace.mjs';
import { createApp } from '../src/server.mjs';

async function fixture(t, extra = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-workspace-test-'));
  const config = { workspace: path.join(root, 'workspace'), dataRoot: path.join(root, 'state'), maxJobs: 4, ...extra };
  await mkdir(config.workspace); await mkdir(config.dataRoot);
  const jobs = new Jobs(config); await jobs.init();
  const batches = new Workspace(config, jobs); await batches.init();
  t.after(async () => {
    for (const execution of (await batches.list()).executions) await batches.cancel({ execution_id: execution.execution_id });
    for (const job of await jobs.list()) await jobs.cancel({ job_id: job.id });
    const roots = [path.join(config.dataRoot, 'jobs'), path.join(config.dataRoot, 'batches')];
    const deadline = Date.now() + 3500;
    while (Date.now() < deadline) {
      const states = [...await jobs.list(), ...(await batches.list()).executions];
      let active = false;
      for (const state of states) {
        const directory = path.join(roots[state.id ? 0 : 1], state.id ?? state.execution_id);
        try { const owner = JSON.parse(await readFile(path.join(directory, 'owner.json'), 'utf8')); if (await processIdentity(owner.pid)) active = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (!active) break;
      await delay(50);
    }
    await rm(root, { recursive: true, force: true });
  });
  return { root, config, jobs, batches };
}

async function complete(batches, execution_id, timeout = 10000) {
  const deadline = Date.now() + timeout;
  do {
    const result = await batches.read({ execution_id });
    if (batchTerminal.has(result.status)) return result;
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error('Batch did not finish');
}

test('batch creates a project, guards atomic edits and runs commands in project cwd', async t => {
  const { batches, config } = await fixture(t);
  const original = 'console.log("first")\n';
  const expected_sha256 = createHash('sha256').update(original).digest('hex');
  const unicode = '你好🌍'.repeat(15000);
  const result = await batches.execute({ cwd: 'new-project', wait_ms: 10000, steps: [
    { type: 'write', path: 'src/main.js', content: original },
    { type: 'write', path: 'src/main.js', content: 'console.log("second")\n', expected_sha256 },
    { type: 'exec', argv: [process.execPath, 'src/main.js'] },
    { type: 'write', path: '中文.txt', content: unicode }
  ] });
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  assert.deepEqual(result.steps.map(step => step.status), ['succeeded', 'succeeded', 'succeeded', 'succeeded']);
  assert.equal(result.steps[2].result.output, 'second\n');
  assert.equal(result.steps[2].result.exit_code, 0);
  assert.equal(await readFile(path.join(config.workspace, 'new-project/src/main.js'), 'utf8'), 'console.log("second")\n');
  assert.equal(await readFile(path.join(config.workspace, 'new-project/中文.txt'), 'utf8'), unicode);
  const guarded = await batches.execute({ cwd: 'new-project', wait_ms: 10000, steps: [
    { type: 'write', path: 'src/main.js', content: 'overwrite', expected_sha256 },
    { type: 'write', path: 'should-not-exist', content: 'bad' }
  ] });
  assert.equal(guarded.status, 'failed');
  assert.match(guarded.steps[0].error, /sha256 mismatch/);
  assert.equal(guarded.steps[1].status, 'skipped');
  assert.equal(await readFile(path.join(config.workspace, 'new-project/src/main.js'), 'utf8'), 'console.log("second")\n');
});

test('independent steps execute in parallel and dependent work waits for both', async t => {
  const { batches } = await fixture(t);
  const peer = (self, other) => `const fs=require('node:fs');fs.writeFileSync('${self}.ready','yes');const limit=Date.now()+2500;const timer=setInterval(()=>{if(fs.existsSync('${other}.ready')){clearInterval(timer);fs.writeFileSync('${self}.done','yes');console.log('${self} done')}else if(Date.now()>limit){clearInterval(timer);process.exit(9)}},20)`;
  const result = await batches.execute({ parallelism: 2, wait_ms: 10000, steps: [
    { id: 'left', type: 'exec', depends_on: [], argv: [process.execPath, '-e', peer('left', 'right')] },
    { id: 'right', type: 'exec', depends_on: [], argv: [process.execPath, '-e', peer('right', 'left')] },
    { id: 'join', type: 'exec', depends_on: ['left', 'right'], argv: [process.execPath, '-e', "const fs=require('node:fs');fs.readFileSync('left.done');fs.readFileSync('right.done');console.log('joined')"] }
  ] });
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  assert.equal(result.steps[2].result.output, 'joined\n');
});

test('whole-plan validation prevents early writes and runner helpers reject symlink escapes', async t => {
  const { batches, config } = await fixture(t);
  await assert.rejects(batches.execute({ steps: [{ id: 'write', type: 'write', path: 'never', content: 'bad' }, { type: 'exec', depends_on: ['missing'], command: 'true' }] }), /Unknown dependency/);
  await assert.rejects(readFile(path.join(config.workspace, 'never')), { code: 'ENOENT' });
  await assert.rejects(batches.execute({ steps: [{ id: 'a', type: 'mkdir', path: 'a', depends_on: ['b'] }, { id: 'b', type: 'mkdir', path: 'b', depends_on: ['a'] }] }), /cycle/);
  await assert.rejects(batches.execute({ steps: [{ type: 'write', path: '../escape', content: 'bad' }] }), /traversal/);
  await assert.rejects(batches.execute({ steps: [{ type: 'write', path: 'a' }] }), /requires content/);
  await symlink(config.dataRoot, path.join(config.workspace, 'escape'));
  const result = await batches.execute({ wait_ms: 10000, steps: [{ type: 'write', path: 'escape/leak', content: 'bad' }] });
  assert.equal(result.status, 'failed');
  assert.match(result.steps[0].error, /symlinks/);
  await assert.rejects(readFile(path.join(config.dataRoot, 'leak')), { code: 'ENOENT' });
});

test('failed dependencies skip while explicitly independent work can continue', async t => {
  const { batches, config } = await fixture(t);
  const result = await batches.execute({ stop_on_error: false, wait_ms: 10000, steps: [
    { id: 'fail', type: 'exec', argv: [process.execPath, '-e', 'console.error("expected failure");process.exit(7)'] },
    { type: 'write', path: 'skipped', content: 'never' },
    { id: 'independent', type: 'write', depends_on: [], path: 'independent', content: 'ok' }
  ] });
  assert.equal(result.status, 'failed');
  assert.equal(result.steps[0].result.exit_code, 7);
  assert.equal(result.steps[1].status, 'skipped');
  assert.equal(result.steps[2].status, 'succeeded');
  assert.equal(await readFile(path.join(config.workspace, 'independent'), 'utf8'), 'ok');
});

test('batch survives HTTP app recreation and request_id prevents duplicate effects', async t => {
  const { config, batches } = await fixture(t);
  const app = await createApp(config);
  const args = { request_id: 'stable-batch', wait_ms: 0, steps: [
    { type: 'exec', argv: [process.execPath, '-e', "require('node:fs').appendFileSync('count','x');setTimeout(()=>console.log('done'),500)"] }
  ] };
  const first = await app.workspaceBatches.execute(args);
  app.server.emit('close');
  const recreated = await createApp(config);
  t.after(() => recreated.server.emit('close'));
  const retry = await recreated.workspaceBatches.execute(args);
  assert.equal(retry.execution_id, first.execution_id);
  const result = await complete(batches, first.execution_id);
  assert.equal(result.status, 'succeeded');
  assert.equal(await readFile(path.join(config.workspace, 'count'), 'utf8'), 'x');
  await assert.rejects(batches.execute({ ...args, steps: [{ type: 'exec', command: 'false' }] }), /different batch/);
  assert.equal((await batches.list()).executions.length, 1);
});

test('HTTP checks retry readiness and background jobs remain monitorable and cancellable', async t => {
  const { batches, jobs } = await fixture(t, { maxJobs: 1 });
  const listener = http.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const content = `const http=require('node:http');let count=0;http.createServer((req,res)=>{res.statusCode=++count<2?503:200;res.end('ready')}).listen(${port},'127.0.0.1');console.log('listening');`;
  const result = await batches.execute({ wait_ms: 10000, steps: [
    { type: 'write', path: 'server.cjs', content },
    { id: 'server', type: 'exec', argv: [process.execPath, 'server.cjs'], background: true, timeout_seconds: 60 },
    { type: 'http_check', url: `http://127.0.0.1:${port}/health`, retry_interval_ms: 100, timeout_seconds: 5 }
  ] });
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  assert.equal(result.steps[1].status, 'started');
  assert.ok(result.steps[1].job_id);
  assert.equal(result.steps[2].result.body, 'ready');
  assert.ok(result.steps[2].result.attempts >= 2);
  const serverJob = await jobs.status(result.steps[1].job_id);
  assert.equal(serverJob.status, 'running');
  await batches.cancel({ execution_id: result.execution_id });
  for (let i = 0; i < 50 && await processIdentity(serverJob.command_pid); i++) await delay(50);
  assert.equal(await processIdentity(serverJob.command_pid), null);
});

test('cancelling a running batch stops its command and skips pending writes', async t => {
  const { batches, config, jobs } = await fixture(t);
  const started = await batches.execute({ wait_ms: 0, steps: [
    { type: 'exec', argv: [process.execPath, '-e', 'setInterval(()=>{},100)'] },
    { type: 'write', path: 'never', content: 'bad' }
  ] });
  let state;
  for (let i = 0; i < 100; i++) { state = await batches.read({ execution_id: started.execution_id }); if (state.steps[0].job_id) break; await delay(20); }
  assert.ok(state.steps[0].job_id);
  await batches.cancel({ execution_id: started.execution_id });
  const result = await complete(batches, started.execution_id);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.steps[1].status, 'skipped');
  await assert.rejects(readFile(path.join(config.workspace, 'never')), { code: 'ENOENT' });
  assert.equal((await jobs.read({ job_id: state.steps[0].job_id })).status, 'cancelled');
});

test('global command admission remains bounded across separate coordinators', async t => {
  const { jobs, config } = await fixture(t, { maxJobs: 2 });
  const other = new Jobs(config); await other.init();
  const outcomes = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => (i % 2 ? jobs : other).start({ argv: [process.execPath, '-e', 'setTimeout(()=>{},1500)'] })));
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 2);
  for (const result of outcomes.filter(result => result.status === 'rejected')) assert.match(result.reason.message, /Concurrent job limit/);
});

test('immediate cancellation before coordinator startup skips all effects', async t => {
  const { batches, config } = await fixture(t);
  const result = await batches.execute({ wait_ms: 0, steps: [{ type: 'write', path: 'never', content: 'bad' }] });
  await batches.cancel({ execution_id: result.execution_id });
  const cancelled = await complete(batches, result.execution_id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.steps[0].status, 'skipped');
  await assert.rejects(readFile(path.join(config.workspace, 'never')), { code: 'ENOENT' });
});

test('failed readiness cleans up background services and batch timeouts stop active commands', async t => {
  const { batches, jobs } = await fixture(t);
  const failed = await batches.execute({ wait_ms: 10000, steps: [
    { id: 'service', type: 'exec', argv: [process.execPath, '-e', 'setInterval(()=>{},100)'], background: true, timeout_seconds: 60 },
    { type: 'http_check', url: 'http://127.0.0.1:1/health', timeout_seconds: 1 }
  ] });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.steps[1].status, 'failed');
  const service = await jobs.status(failed.steps[0].job_id);
  for (let i = 0; i < 50 && await processIdentity(service.command_pid); i++) await delay(50);
  assert.equal(await processIdentity(service.command_pid), null);
  const timedOut = await batches.execute({ wait_ms: 10000, timeout_seconds: 1, steps: [
    { type: 'exec', argv: [process.execPath, '-e', 'setInterval(()=>{},100)'] },
    { type: 'write', path: 'never', content: 'bad' }
  ] });
  assert.equal(timedOut.status, 'failed');
  assert.match(timedOut.error, /timeout/);
  assert.equal(timedOut.steps[1].status, 'skipped');
});

test('an exited background command cannot pass by checking an unrelated healthy server', async t => {
  const { batches } = await fixture(t);
  const server = http.createServer((_req, res) => setTimeout(() => res.end('unrelated healthy service'), 600));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const result = await batches.execute({ wait_ms: 10000, steps: [
    { type: 'exec', background: true, argv: [process.execPath, '-e', 'setTimeout(()=>process.exit(4),250)'] },
    { type: 'http_check', url: `http://127.0.0.1:${server.address().port}/health`, timeout_seconds: 3 }
  ] });
  assert.equal(result.status, 'failed');
  assert.equal(result.steps[0].status, 'failed');
  assert.equal(result.steps[0].result.exit_code, 4);
});

test('unique, hash-guarded replace edits just one snippet and rejects duplicates', async t => {
  const { batches, config } = await fixture(t);
  const file = path.join(config.workspace, 'settings.txt');
  await writeFile(file, 'top\nKEY=before\nbottom\n');
  const original = await readFile(file);
  const expected_sha256 = createHash('sha256').update(original).digest('hex');
  const updated = await batches.execute({ wait_ms: 10000, steps: [
    {type:'replace',path:'settings.txt',old_text:'KEY=before',new_text:'KEY=after',expected_sha256}
  ]});
  assert.equal(updated.status,'succeeded',JSON.stringify(updated));
  assert.equal((await readFile(file,'utf8')),'top\nKEY=after\nbottom\n');
  assert.equal(updated.steps[0].result.replacements,1);
  const stale = await batches.execute({ wait_ms: 10000, steps: [
    {type:'replace',path:'settings.txt',old_text:'KEY=after',new_text:'KEY=oops',expected_sha256}
  ]});
  assert.equal(stale.status,'failed',JSON.stringify(stale));
  assert.match(stale.steps[0].error,/sha256 mismatch/);
  await writeFile(file,'same\nsame\n');
  const duphash = createHash('sha256').update(await readFile(file)).digest('hex');
  const dup = await batches.execute({wait_ms:10000,steps:[
    {type:'replace',path:'settings.txt',old_text:'same',new_text:'mutated',expected_sha256:duphash}
  ]});
  assert.equal(dup.status,'failed',JSON.stringify(dup));
  assert.match(dup.steps[0].error,/exactly one occurrence/);
  assert.equal((await readFile(file,'utf8')),'same\nsame\n');
  await assert.rejects(batches.execute({steps:[
    {type:'replace',path:'settings.txt',old_text:'same',new_text:'changed'}
  ]}),/requires the exact current expected_sha256/);
});
