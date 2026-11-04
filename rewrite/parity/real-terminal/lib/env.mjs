// One isolated home per CLI run: scratch HOME / XDG dirs, settings pointing at the loopback provider, and a
// private copy of the conversation store so a run never writes into the store it was given.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repo = path.resolve(here, '..', '..', '..', '..');

export const CLIS = {
  legacy: { name: 'legacy term2', cli: path.join(repo, 'dist', 'cli.js') },
  next: { name: 'term2-next', cli: path.join(repo, 'rewrite', 'dist', 'rewrite', 'src', 'app', 'cli.js') },
};

/**
 * Both CLIs get roots of the same length (`.../rt-legacy-xxxx` vs `.../rt-next-xxxxxx`), so paths that reach the
 * screen have identical widths and only differ inside masked spans.
 */
export function makeRoot(scratch, which) {
  const tag = which === 'legacy' ? 'L' : 'N';
  const root = fs.mkdtempSync(path.join(scratch, `rt${tag}-`));
  return fs.realpathSync(root);
}

export function prepareHome({ root, baseUrl, store, settings = {}, reuse = false }) {
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'work');
  const conversations = path.join(root, 'conversations');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  if (store) {
    copyStore(store, conversations);
  } else {
    fs.mkdirSync(conversations, { recursive: true });
  }
  if (!reuse) seedWorkspace(workspace);
  const env = {
    PATH: process.env.PATH,
    SHELL: '/bin/bash',
    LANG: 'C.UTF-8',
    TZ: 'UTC',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '1',
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_RUNTIME_DIR: path.join(root, 'runtime'),
    TMPDIR: path.join(root, 'tmp'),
    TERM2_CONFIG_DIR: path.join(home, '.term2'),
    TERM2_CACHE_DIR: path.join(home, '.cache', 'term2'),
    TERM2_CONVERSATIONS_DIR: conversations,
    DISABLE_LOGGING: '1',
    CI: 'false',
  };
  const settingsDir = path.join(env.XDG_STATE_HOME, 'term2-nodejs');
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify(
      merge(
        {
          agent: { retryAttempts: 0, modelSelection: { model: 'mock-alpha', provider: 'mockprov' } },
          providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl, apiKey: 'test-key' }],
          sandbox: { enabled: false },
        },
        settings,
      ),
      null,
      2,
    ),
  );
  return { root, home, workspace, conversations, env };
}

/** Full copy (not hard links): a resumed session appends to its file, which must never reach the source store. */
function copyStore(store, target) {
  fs.cpSync(store, target, { recursive: true, dereference: false, preserveTimestamps: true });
}

function seedWorkspace(workspace) {
  fs.writeFileSync(path.join(workspace, 'README.md'), '# demo project\n\nA small workspace for the parity walk.\n');
  fs.writeFileSync(
    path.join(workspace, 'notes.txt'),
    Array.from({ length: 40 }, (_, i) => `line ${i + 1}: the quick brown fox`).join('\n') + '\n',
  );
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'main.js'), "export function main() {\n  return 'hello';\n}\n");
}

function merge(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return extra ?? base;
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value) ? merge(base?.[key] ?? {}, value) : value;
  }
  return out;
}

export function scratchDir(preferred) {
  const dir = preferred ?? fs.mkdtempSync(path.join(os.tmpdir(), 'term2-rt-'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
