// Trusted detached coordinator; all user code and file/network helpers run via
// Jobs under the configured unprivileged identity. No OAuth secrets are passed.
import { access, appendFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJSON, readJSON } from './common.mjs';
import { Jobs } from './jobs.mjs';

const dir = process.argv[2];
const stateFile = path.join(dir, 'state.json');
const patchWorker = fileURLToPath(new URL('./patch-worker.mjs', import.meta.url));
const helper = fileURLToPath(new URL('./workspace-step.mjs', import.meta.url));
const finishedJob = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
let cancelled = false;
process.on('SIGTERM', () => { cancelled = true; });
process.on('SIGINT', () => { cancelled = true; });
const buildClient = fileURLToPath(new URL('./container-build.py', import.meta.url));
let state, plan, jobs, config;

async function save(message) {
  state.revision++;
  state.updated_at = new Date().toISOString();
  await atomicJSON(stateFile, state);
  if (message) await appendFile(path.join(dir, 'output.log'), `${state.updated_at} ${message}\n`, { mode: 0o600 });
}

async function capture(step, spec, job) {
  const logs = await jobs.read({ job_id: job.id, max_bytes: spec.type === 'exec' ? plan.max_output_bytes : spec.type === 'container_build' ? 262144 : 32768 });
  step.result = { exit_code: logs.exit_code, output: logs.output, next_offset: logs.next_offset, has_more: logs.has_more };
  if (logs.reason) step.result.reason = logs.reason;
  if (logs.error) step.error = logs.error;
  if (spec.type !== 'exec') {
    try {
      const result = JSON.parse(logs.output);
      if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') throw new Error('Invalid helper result');
      step.result = { ...result, exit_code: logs.exit_code, next_offset: logs.next_offset, has_more: logs.has_more };
      if (!result.ok) step.error = result.error || 'Workspace helper failed';
    } catch { step.error = 'Workspace helper did not return a complete structured result; inspect job_read logs'; }
  }
}

async function cancelJobs(includeBackground) {
  // Also recover a job admitted immediately before a coordinator interruption.
  const associated = (await jobs.list()).filter(job => job.batch_execution_id === state.execution_id);
  const awaiting = [];
  for (const job of associated) {
    const step = state.steps.find(step => step.id === job.batch_step_id);
    if (step && !step.job_id) step.job_id = job.id;
    if (!finishedJob.has(job.status) && (includeBackground || !step?.background)) {
      try {
        const result = await jobs.cancel({ job_id: job.id });
        if (!finishedJob.has(result.status)) awaiting.push(job.id);
      } catch (error) { state.cleanup_errors ??= []; state.cleanup_errors.push(error.message); }
    }
  }
  const deadline = Date.now() + 500;
  while (awaiting.length && Date.now() < deadline) {
    await delay(25);
    for (let i = awaiting.length-1; i >= 0; i--) {
      try { if (finishedJob.has((await jobs.status(awaiting[i])).status)) awaiting.splice(i, 1); }
      catch (error) { state.cleanup_errors ??= []; state.cleanup_errors.push(error.message); awaiting.splice(i, 1); }
    }
  }
  if (awaiting.length) state.cleanup_pending_jobs = awaiting;
}

try {
  plan = await readJSON(path.join(dir, 'plan.json'));
  state = await readJSON(stateFile);
  config = JSON.parse(process.env.BATCH_CONFIG);
  jobs = new Jobs(config);
  await jobs.init();
  state.status = 'running';
  state.started_at = new Date().toISOString();
  await save('Batch started');
  const deadline = Date.now() + plan.timeout_seconds * 1000;
  const byID = new Map(state.steps.map(step => [step.id, step]));
  const specs = new Map(plan.steps.map(step => [step.id, step]));
  while (true) {
    try { await access(path.join(dir, 'cancel')); cancelled = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (cancelled || Date.now() >= deadline) {
      state.status = cancelled ? 'cancelled' : 'failed';
      if (!cancelled) state.error = 'Batch timeout exceeded';
      await cancelJobs(true);
      for (const step of state.steps) {
        if (step.status === 'pending') { step.status = 'skipped'; step.error = 'Batch stopped before this step started'; }
        else if (step.status === 'running') { step.status = 'cancelled'; step.error = 'Job cancellation requested; confirm with job_read'; }
      }
      break;
    }
    for (const step of state.steps.filter(step => step.status === 'running' || step.status === 'started')) {
      const spec = specs.get(step.id);
      const job = await jobs.status(step.job_id);
      if (step.status === 'started' && !finishedJob.has(job.status)) continue;
      if (spec.background && job.status === 'running' && job.command_pid) {
        step.status = 'started';
        step.finished_at = new Date().toISOString();
        await capture(step, spec, job);
        await save(`${step.id}: background started (readiness requires its check step)`);
      } else if (finishedJob.has(job.status)) {
        const previouslyStarted = step.status === 'started';
        await capture(step, spec, job);
        step.status = job.status === 'succeeded' && !spec.background && !step.error ? 'succeeded' : 'failed';
        if (spec.background && !step.error) step.error = previouslyStarted ? 'Background command exited during the batch' : 'Background command exited before startup was observed';
        if (step.status === 'failed' && !step.error) step.error = `Job ${job.status}, exit code ${job.exit_code}`;
        step.finished_at = new Date().toISOString();
        await save(`${step.id}: ${step.status}`);
      }
    }
    const failed = state.steps.some(step => step.status === 'failed');
    for (const step of state.steps.filter(step => step.status === 'pending')) {
      if ((failed && plan.stop_on_error) || step.depends_on.some(id => ['failed', 'skipped', 'cancelled'].includes(byID.get(id).status))) {
        step.status = 'skipped'; step.error = failed && plan.stop_on_error ? 'Stopped after step failure' : 'Dependency did not succeed';
        await save(`${step.id}: skipped`);
      }
    }
    for (const step of state.steps.filter(step => step.status === 'pending')) {
      if (cancelled || Date.now() >= deadline) break;
      if (state.steps.filter(step => step.status === 'running').length >= plan.parallelism) break;
      if (!step.depends_on.every(id => ['succeeded', 'started'].includes(byID.get(id).status))) continue;
      const spec = specs.get(step.id);
      try {
        const args = spec.type === 'exec' ? { argv: spec.argv, cwd: path.join(plan.cwd, spec.cwd), env: spec.env, timeout_seconds: spec.timeout_seconds }
          : { argv: [process.execPath, helper], cwd: '.', stdin: JSON.stringify({ workspace: jobs.workspace, cwd: plan.cwd, step: spec }), timeout_seconds: spec.type === 'http_check' ? spec.timeout_seconds + 5 : 60, job_kind: 'workspace_helper' };
        if (['write','replace','mkdir','patch'].includes(spec.type)) args.argv = ['/usr/bin/flock', '-x', path.join(jobs.executionHome || jobs.workspace, '.workspace-patch.lock'), process.execPath, spec.type==='patch'?patchWorker:helper];
        if (spec.type === 'container_build') {
          if (!config.containerBuildSocket) throw new Error('Rootless container builder is not configured');
          Object.assign(args, { argv: ['/usr/bin/python3', buildClient], stdin: JSON.stringify({ workspace: jobs.workspace, cwd: plan.cwd, step: spec, build_socket: config.containerBuildSocket }), timeout_seconds: spec.timeout_seconds + 60 });
        }
        args.batch_execution_id = state.execution_id;
        args.batch_step_id = step.id;
        args.trace_id = state.trace_id;
        // The batch coordinator already polls children: do not wait 500ms here.
        const job = await jobs.start({...args,wait_ms:0});
        Object.assign(step, { status: 'running', job_id: job.id, background: spec.background ?? false, started_at: new Date().toISOString() });
        await save(`${step.id}: running`);
      } catch (error) {
        if (error.message === 'Concurrent job limit reached') break;
        step.status = 'failed'; step.error = error.message; step.finished_at = new Date().toISOString();
        await save(`${step.id}: failed`);
        if (plan.stop_on_error) break;
      }
    }
    if (state.steps.every(step => !['pending', 'running'].includes(step.status))) {
      for (const step of state.steps.filter(step => step.status === 'started')) {
        const job = await jobs.status(step.job_id);
        if (finishedJob.has(job.status)) {
          await capture(step, specs.get(step.id), job);
          step.status = 'failed'; step.error ??= 'Background command exited during the batch';
          await save(`${step.id}: failed`);
        }
      }
      state.status = state.steps.some(step => step.status === 'failed') ? 'failed' : 'succeeded';
      if (state.status === 'failed' && plan.cleanup_background_on_failure) await cancelJobs(true);
      break;
    }
    await delay(100);
  }
  state.finished_at = new Date().toISOString();
  await save(`Batch ${state.status}`);
} catch (error) {
  if (state) {
    Object.assign(state, { status: cancelled ? 'cancelled' : 'failed', error: error.message, finished_at: new Date().toISOString() });
    if (jobs) { try { await cancelJobs(true); } catch (cleanup) { state.cleanup_errors ??= []; state.cleanup_errors.push(cleanup.message); } }
    await save('Batch coordinator failed').catch(() => {});
  }
  process.exitCode = 1;
} finally {
  // Keep results but avoid retaining source contents/env inputs unnecessarily.
  await rm(path.join(dir, 'plan.json'), { force: true }).catch(() => {});
}
