import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

it('consumes a vendored wire release instead of owning the shared workspace source', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  expect(manifest.devDependencies['@qduc/agent-wire']).toBe('file:vendor/qduc-agent-wire-0.1.0.tgz');
  expect(manifest.scripts.postinstall).toBeUndefined();
  const web = JSON.parse(await readFile('web-client/package.json', 'utf8'));
  expect(web.dependencies['@qduc/agent-wire']).toBe('file:../vendor/qduc-agent-wire-0.1.0.tgz');
});

it('builds the CLI without rebuilding an application-owned wire package', async () => {
  const build = await readFile('scripts/build-with-rollback.mjs', 'utf8');
  const embed = await readFile('scripts/embed-agent-wire.mjs', 'utf8');
  expect(build).not.toContain("run('pnpm', ['--filter', '@qduc/agent-wire', 'build'])");
  expect(embed).not.toContain('packages/wire/dist');
  expect(embed).toContain("import.meta.resolve('@qduc/agent-wire')");
});
