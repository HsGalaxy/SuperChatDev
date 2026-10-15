import { Worker } from 'node:worker_threads';

export function regexScanner(query, caseSensitive) {
  // Validate before launching the worker. Never execute an untrusted pattern
  // on file text on the MCP event loop.
  try { new RegExp(query, caseSensitive ? 'u' : 'iu'); }
  catch (error) { throw new Error('Invalid regex pattern: ' + error.message); }

  const worker = new Worker(new URL('./search-regex-worker.mjs', import.meta.url), {
    workerData: { query, caseSensitive },
    resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 }
  });
  let stopped = false;
  return {
    matches(text, startLine, limit) {
      if (stopped) return Promise.resolve({ timed_out: true });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          done();
          stopped = true;
          worker.terminate().catch(() => {});
          resolve({ timed_out: true });
        }, 350);
        function done() {
          clearTimeout(timer);
          worker.off('message', success);
          worker.off('error', fail);
          worker.off('exit', exited);
        }
        function success(message) {
          if (message.id !== 1) return;
          done();
          message.error ? reject(new Error(message.error)) : resolve(message);
        }
        function fail(error) { done(); reject(error); }
        function exited() { fail(new Error('Regex worker exited unexpectedly')); }
        worker.on('message', success);
        worker.once('error', fail);
        worker.once('exit', exited);
        worker.postMessage({ id: 1, text, startLine, limit });
      });
    },
    async close() { stopped = true; await worker.terminate().catch(() => {}); }
  };
}
