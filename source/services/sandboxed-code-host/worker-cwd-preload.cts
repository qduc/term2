const cwd = process.env.TERM2_SANDBOX_CWD;
if (!cwd) throw new Error('TERM2_SANDBOX_CWD is required for sandbox worker startup');

// Node initializes a worker by calling process.cwd(). Keep that bootstrap
// independent from the process cwd, which may have been removed after the
// execution context pinned its own valid workspace.
process.cwd = () => cwd;
