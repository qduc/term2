/** Watch Term2's sources. @qduc/agent-core is an npm dependency, not built here. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
// Node's watcher supports workspace filesystems without native fanotify handles.
const compiler = fileURLToPath(new URL('./bin/tsc6', import.meta.resolve('typescript/package.json')));

const watchers = [];
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const watcher of watchers) watcher.kill('SIGTERM');
}
for (const project of ['tsconfig.build.json']) {
  const watcher = spawn(process.execPath, [compiler, '-p', project, '--watch', '--preserveWatchOutput'], {
    cwd: root,
    stdio: 'inherit',
  });
  watchers.push(watcher);
  watcher.on('error', (error) => {
    console.error(`[dev] could not start ${project}: ${error.message}`);
    stop(1);
  });
  watcher.on('exit', (code, signal) => {
    if (!stopping) stop(code ?? (signal ? 1 : 0));
  });
}
process.on('SIGINT', () => stop(130));
process.on('SIGTERM', () => stop(143));
