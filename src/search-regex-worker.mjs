// Isolate user-supplied regular expressions from the MCP event loop.
// The parent enforces a per-file deadline and terminates this worker on timeout.
import { parentPort, workerData } from 'node:worker_threads';

const expression = new RegExp(workerData.query, workerData.caseSensitive ? 'u' : 'iu');
parentPort.on('message', ({ id, text, startLine, limit }) => {
  try {
    const lines = text.split('\n');
    const matches = [];
    let nextLine = lines.length;
    for (let i = startLine; i < lines.length; i++) {
      expression.lastIndex = 0;
      if (!expression.test(lines[i])) continue;
      const start = Math.max(0, i - 2);
      const end = Math.min(lines.length, i + 3);
      matches.push({
        line: i + 1,
        text: lines[i].slice(0, 600).replace(/\r$/, ''),
        text_truncated: lines[i].length > 600,
        context: lines.slice(start, end).map((line, n) =>
          ({ line: start + n + 1, text: line.slice(0, 300).replace(/\r$/, '') }))
      });
      if (matches.length >= limit) {
        nextLine = i + 1;
        break;
      }
    }
    parentPort.postMessage({ id, matches, nextLine });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error.message).slice(0, 300) });
  }
});
