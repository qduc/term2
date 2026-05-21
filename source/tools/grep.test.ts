import test from 'ava';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createGrepToolDefinition } from './grep.js';

async function withTempDir(run: (dir: string) => Promise<void>) {
  const originalCwd = process.cwd;
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'term2-grep-test-'));
  const workspaceDir = path.join(rootDir, 'workspace');
  await fs.mkdir(workspaceDir, { recursive: true });

  process.cwd = () => workspaceDir;

  try {
    await run(workspaceDir);
  } finally {
    process.cwd = originalCwd;
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

test.serial('execute: file_pattern does not include gitignored files', async (t) => {
  await withTempDir(async (dir) => {
    await fs.mkdir(path.join(dir, 'source'), { recursive: true });
    await fs.writeFile(path.join(dir, '.gitignore'), '*.tsbuildinfo\n');
    await fs.writeFile(path.join(dir, 'source', 'app.ts'), 'const value = "undo";\n');
    await fs.writeFile(path.join(dir, 'tsconfig.tsbuildinfo'), '{"fileNames":["undo"]}\n');

    const result = await createGrepToolDefinition().execute({
      pattern: 'undo',
      path: '.',
      file_pattern: '*.ts*',
    });

    t.true(result.includes('source/app.ts'));
    t.false(result.includes('tsconfig.tsbuildinfo'));
  });
});
