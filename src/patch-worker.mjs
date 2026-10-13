import { applyPatch } from './patch.mjs';
let result;
try {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > 1024 * 1024) throw new Error('Patch request exceeds 1 MiB'); chunks.push(chunk); }
  result = await applyPatch(JSON.parse(Buffer.concat(chunks).toString('utf8')));
} catch (error) { result = { ok: false, error: error.message }; }
await new Promise(resolve => process.stdout.write(JSON.stringify(result) + '\n', resolve));
process.exitCode = result.ok ? 0 : 1;
