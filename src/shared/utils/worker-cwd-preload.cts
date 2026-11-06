const { statSync } = require('node:fs');
const { isMainThread } = require('node:worker_threads');

// Node can cache cwd before another process removes it. Check in the worker,
// before eval/loader bootstrap, not in the parent. This is a module-resolution
// fallback only: application filesystem authority stays in ExecutionContext.
if (!isMainThread) {
  const nativeCwd = process.cwd;
  process.cwd = () => {
    try {
      const cwd = nativeCwd();
      if (statSync(cwd).isDirectory()) return cwd;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    return __dirname;
  };
}
