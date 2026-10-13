// Only explicitly configured toolchain defaults cross the credential boundary.
export function executionEnvironment({ executionHome, executionEnv = {} } = {}) {
  return { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', LANG: process.env.LANG || 'C.UTF-8',
    HOME: executionHome || process.env.HOME, ...executionEnv };
}

export function validateExecutionEnv(value = {}) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.entries(value).some(([key, text]) =>
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof text !== 'string' || text.includes('\0'))) throw new Error('EXECUTION_ENV must be a JSON object of string environment defaults');
  return value;
}
