// Desktop Commander's wait budget is not a process execution deadline.
export async function clarifyProcessResult(name, args, result, upstream) {
  if (!['start_process', 'interact_with_process', 'read_process_output'].includes(name) || result.isError) return result;
  const text = result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') || '';
  const waitExpired = text.includes('Response may be incomplete (timeout reached)');
  if (!waitExpired) return result;
  let alive = null;
  if (Number.isSafeInteger(args.pid) && args.pid > 0) {
    try {
      const sessions = await upstream.request('tools/call', { name: 'list_sessions', arguments: {} });
      if (!sessions.isError) alive = sessions.content.some(item => item.type === 'text' && new RegExp(`(?:^|\\n)PID: ${args.pid}(?:,| |$)`).test(item.text));
    } catch { /* Preserve output even if the optional status query fails. */ }
  }
  const note = 'Response wait budget expired. This is not an execution timeout or proof of failure. Read more output and check session status; do not resend the same input blindly.';
  return { ...result,
    content: result.content.map(item => item.type === 'text' ? { ...item, text: item.text.replace('Response may be incomplete (timeout reached)', note) } : item),
    structuredContent: { ...result.structuredContent, process_status: { pid: args.pid ?? null, response_wait_expired: true, session_active: alive,
      execution_outcome: 'unknown', next_step: 'Use read_process_output; list_sessions confirms whether the session remains active. A live REPL may be computing or waiting for input. Inspect actual exit code before deciding success.' } } };
}
