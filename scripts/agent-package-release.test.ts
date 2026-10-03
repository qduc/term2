import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('shared package release safety', () => {
  const workflow = parse(readFileSync('.github/workflows/publish-agent-packages.yml', 'utf8'));

  it('does not publish on pushes or by default', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(workflow.on.workflow_dispatch.inputs.publish.default).toBe(false);
    expect(workflow.jobs.validate.if).toBe("github.ref == 'refs/heads/main'");
    expect(workflow.jobs.publish.needs).toBe('validate');
    expect(workflow.jobs.publish.if).toBe('inputs.publish');
    expect(workflow.jobs.publish.environment).toBe('npm-agent-packages');
    expect(workflow.jobs.publish.permissions['id-token']).toBe('write');
  });

  it('publishes the validated tarballs rather than rebuilding on the publish runner', () => {
    const commands = workflow.jobs.publish.steps.flatMap((step: { run?: string }) => (step.run ? [step.run] : []));
    expect(commands).toHaveLength(2);
    for (const command of commands) {
      expect(command).toMatch(
        /^npm publish release-artifacts\/qduc-agent-(wire|core)-\*\.tgz --access public --provenance$/,
      );
    }
    expect(
      workflow.jobs.validate.steps.some(
        (step: { run?: string }) => step.run === 'node scripts/agent-package-smoke.mjs',
      ),
    ).toBe(true);
  });

  for (const name of ['core', 'wire']) {
    it(`makes ${name} packable with a release version and public metadata`, () => {
      const manifest = JSON.parse(readFileSync(`packages/${name}/package.json`, 'utf8'));
      expect(manifest.version).not.toBe('0.0.0');
      expect(manifest.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
      expect(manifest.license).toBe('MIT');
      expect(manifest.publishConfig.access).toBe('public');
      expect(manifest.scripts.prepack).toBe('pnpm run build');
      expect(manifest.repository.directory).toBe(`packages/${name}`);
      expect(readFileSync(`packages/${name}/LICENSE`, 'utf8')).toBe(readFileSync('LICENSE', 'utf8'));
    });
  }
});
