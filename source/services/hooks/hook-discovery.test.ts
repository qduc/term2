import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { HookDiscovery } from './hook-discovery.js';

import { realpath } from 'node:fs/promises';

const temporaryDirectories: string[] = [];

async function makeDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const canonical = await realpath(directory);
  temporaryDirectories.push(canonical);
  return canonical;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('HookDiscovery', () => {
  it('discovers user files before project files in lexical order and filters extensions', async () => {
    const home = await makeDirectory('term2-hook-home-');
    const project = await makeDirectory('term2-hook-project-');
    const userHooks = join(home, '.term2', 'hooks');
    const projectHooks = join(project, '.term2', 'hooks');
    await mkdir(userHooks, { recursive: true });
    await mkdir(projectHooks, { recursive: true });
    await writeFile(join(userHooks, 'z-last.ts'), 'export default () => {}');
    await writeFile(join(userHooks, 'a-first.js'), 'export default () => {}');
    await writeFile(join(userHooks, 'ignored.json'), '{}');
    await writeFile(join(projectHooks, 'b-project.mjs'), 'export default () => {}');
    await writeFile(join(projectHooks, 'a-project.ts'), 'export default () => {}');

    const result = await new HookDiscovery({
      homeDir: home,
      cwd: project,
      trustedProjectRoots: [project],
    }).discover();

    expect(result.files.map((file) => file.path)).toEqual([
      join(userHooks, 'a-first.js'),
      join(userHooks, 'z-last.ts'),
      join(projectHooks, 'a-project.ts'),
      join(projectHooks, 'b-project.mjs'),
    ]);
    expect(result.files.map((file) => file.scope)).toEqual(['user', 'user', 'project', 'project']);
  });

  it('rejects symlinked hook files and skips an untrusted project', async () => {
    const home = await makeDirectory('term2-hook-home-');
    const project = await makeDirectory('term2-hook-project-');
    const outside = await makeDirectory('term2-hook-outside-');
    const userHooks = join(home, '.term2', 'hooks');
    const projectHooks = join(project, '.term2', 'hooks');
    await mkdir(userHooks, { recursive: true });
    await mkdir(projectHooks, { recursive: true });
    await writeFile(join(outside, 'outside.ts'), 'export default () => {}');
    await symlink(join(outside, 'outside.ts'), join(userHooks, 'escape.ts'));
    await writeFile(join(userHooks, 'safe.ts'), 'export default () => {}');
    await writeFile(join(projectHooks, 'project.ts'), 'export default () => {}');

    const result = await new HookDiscovery({ homeDir: home, cwd: project }).discover();

    expect(result.files.map((file) => file.path)).toEqual([join(userHooks, 'safe.ts')]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('symlink_rejected');
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('project_hooks_untrusted');
  });

  it('honors user and project enable switches before scanning', async () => {
    const home = await makeDirectory('term2-hook-home-');
    const project = await makeDirectory('term2-hook-project-');
    const userHooks = join(home, '.term2', 'hooks');
    const projectHooks = join(project, '.term2', 'hooks');
    await mkdir(userHooks, { recursive: true });
    await mkdir(projectHooks, { recursive: true });
    await writeFile(join(userHooks, 'user.ts'), 'export default () => {}');
    await writeFile(join(projectHooks, 'project.ts'), 'export default () => {}');

    const result = await new HookDiscovery({
      homeDir: home,
      cwd: project,
      trustedProjectRoots: [project],
      userEnabled: false,
      projectEnabled: false,
    }).discover();

    expect(result.files).toEqual([]);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === 'hook_disabled')).toHaveLength(2);
  });

  it('treats missing hook directories as empty', async () => {
    const home = await makeDirectory('term2-hook-home-');
    const project = await makeDirectory('term2-hook-project-');

    const result = await new HookDiscovery({
      homeDir: home,
      cwd: project,
      trustedProjectRoots: [project],
    }).discover();

    expect(result.files).toEqual([]);
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ code: 'discovery_failed' }));
  });
});
