import fs from 'node:fs';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const home = path.resolve(process.argv[2]);
const script = path.join(home, 'sandbox-diagnostic.mjs');
fs.writeFileSync(
  script,
  `import { AnthropicShellSandboxRunner } from ${JSON.stringify(
    new URL('../../dist/utils/shell/sandbox/shell-sandbox-runner.js', import.meta.url).href,
  )};
import { createSandboxRuntimeConfig } from ${JSON.stringify(
    new URL('../../dist/utils/shell/sandbox/sandbox-policy.js', import.meta.url).href,
  )};
import { exec } from 'node:child_process';
import fs from 'node:fs';
const runner = new AnthropicShellSandboxRunner();
const config = createSandboxRuntimeConfig({ cwd: process.cwd(), readPolicy: 'strict', allowReadExtra: [process.env.HOME + '/conversations'] });
const wrapped = await runner.wrap('printf LOCAL_TOOL_PROBE', { cwd: process.cwd(), config });
exec(wrapped.command, { shell: '/usr/bin/zsh' }, (error, stdout, stderr) => {
 console.log(JSON.stringify({ config, wrapped, error: error?.message, stdout, stderr, evaluatorVisible: fs.existsSync(${JSON.stringify(
   path.join(root, '.cheap-evidence'),
 )} + '/rehearsal-v1/manifest.json'), parentGitVisible: fs.existsSync('/home/qduc/term2/.git/HEAD') }));
 process.exit(error ? 1 : 0);
});`,
);
const isolation = [
  '--ro-bind',
  '/',
  '/',
  '--tmpfs',
  os.homedir(),
  '--ro-bind',
  root,
  root,
  '--tmpfs',
  path.join(root, '.cheap-evidence'),
  '--tmpfs',
  path.join(root, 'experiments/bare-profile'),
  '--tmpfs',
  '/tmp',
  '--bind',
  home,
  home,
  '--unshare-pid',
  '--proc',
  '/proc',
  '--dev',
  '/dev',
  '--ro-bind',
  path.dirname(path.dirname(process.execPath)),
  path.dirname(path.dirname(process.execPath)),
  '--',
  process.execPath,
  script,
];
const result = spawnSync('bwrap', isolation, {
  cwd: path.join(home, 'active'),
  env: { PATH: path.join(root, '.cheap-tools/usr/bin') + ':' + process.env.PATH, HOME: home, SHELL: '/usr/bin/zsh' },
  encoding: 'utf8',
  timeout: 20000,
});
const detail = result.stdout ? JSON.parse(result.stdout) : null;
const receipt = {
  status: result.status,
  stdout: detail?.stdout,
  stderr: detail?.stderr ?? result.stderr,
  evaluatorVisible: detail?.evaluatorVisible,
  parentGitVisible: detail?.parentGitVisible,
  error: result.error?.message,
};
if (process.argv[3])
  fs.writeFileSync(path.resolve(process.argv[3]), JSON.stringify({ receipt, detail }, null, 2) + '\n');
console.log(JSON.stringify(receipt));
assert.equal(result.status, 0);
assert.equal(detail.stdout, 'LOCAL_TOOL_PROBE');
assert.equal(detail.evaluatorVisible, false);
assert.equal(detail.parentGitVisible, false);
