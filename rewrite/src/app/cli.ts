#!/usr/bin/env node
// The headless entry point, implemented by M1 task 3. It owns env setup, flags,
// profile selection, refusals (D9, home guard), signals and the exit code, then
// calls `run` from ./run.js.

process.stderr.write('term2: the direct headless path is not implemented yet\n');
process.exitCode = 1;

export {};
