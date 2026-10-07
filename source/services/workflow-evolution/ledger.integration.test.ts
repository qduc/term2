import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import os from 'node:os';
import { mkdir } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { appendEvent, readLedger } from './ledger.js';
import { runDemo } from './demo.js';
import { SkillsService } from '../skills/skills-service.js';
import { snapshotLoadedSkill, digest } from './experiment.js';
import type { ILoggingService } from '../service-interfaces.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function directory() {
  const result = await mkdtemp(join(tmpdir(), 'term2-evolution-test-'));
  directories.push(result);
  return result;
}

it('replays a durable end-to-end decision and observes accepted identity on subsequent real artifact work', async () => {
  const result = await runDemo(await directory());
  expect(result.decision?.verdict).toBe('keep');
  expect(result.activeMethodId).toBe(result.candidateId);
  expect(result.adoption?.runId).toBe('subsequent-work');
  const state = await readLedger(result.ledger);
  const next = state.runs['subsequent-work'];
  expect(await readFile(next.evidence[0].ref, 'utf8')).toBe('- [Install](#install)\n- [Install](#install-1)\n');
  expect(next.loadedMethod).toEqual(state.proposal?.candidate);
  expect(state.review?.pairs).toHaveLength(3);
  expect(Object.values(state.runs).filter((run) => run.purpose === 'work')).toHaveLength(3);
});

it('does not alter durable history on validation failure or an existing writer lock', async () => {
  const result = await runDemo(await directory());
  const before = await readFile(result.ledger, 'utf8');
  await expect(appendEvent(result.ledger, { type: 'promote', id: 'unauthorized' })).rejects.toThrow();
  expect(await readFile(result.ledger, 'utf8')).toBe(before);
  await writeFile(`${result.ledger}.lock`, 'operator must inspect crashed writer');
  await expect(
    appendEvent(result.ledger, {
      type: 'rollback',
      id: 'rollback',
      reason: 'regression',
      evidence: [{ ref: 'trace', digest: 'a'.repeat(64) }],
    }),
  ).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(result.ledger, 'utf8')).toBe(before);
});

it('fails replay when frozen criteria were changed after comparison', async () => {
  const result = await runDemo(await directory());
  const log = JSON.parse(await readFile(result.ledger, 'utf8'));
  log.events[0].criteria.checks = ['weaker-check'];
  await writeFile(result.ledger, JSON.stringify(log));
  await expect(readLedger(result.ledger)).rejects.toThrow('Frozen evaluation criteria changed');
});

it('rejects duplicate demo invocation without overwriting prior artifacts', async () => {
  const output = await directory();
  const result = await runDemo(output);
  const before = await readFile(result.ledger, 'utf8');
  await expect(runDemo(output)).rejects.toThrow('Experiment already initialized');
  expect(await readFile(result.ledger, 'utf8')).toBe(before);
});

it('captures the actual cached project override until SkillsService rediscovers the changed method', async () => {
  const root = await directory();
  const home = join(root, 'home');
  const project = join(root, 'project');
  const userSkill = join(home, '.agents/skills/verify/SKILL.md');
  const projectSkill = join(project, '.agents/skills/verify/SKILL.md');
  await mkdir(join(home, '.agents/skills/verify'), { recursive: true });
  await mkdir(join(project, '.agents/skills/verify'), { recursive: true });
  await writeFile(userSkill, '---\nname: verify\ndescription: verify\n---\nUser method');
  await writeFile(projectSkill, '---\nname: verify\ndescription: verify\n---\nProject incumbent');
  const logger: ILoggingService = {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
    security: () => {},
    setCorrelationId: () => {},
    getCorrelationId: () => undefined,
    clearCorrelationId: () => {},
  };
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  const skills = new SkillsService(logger, project);
  skills.discoverSkills();
  const initial = snapshotLoadedSkill(skills.activateSkill('verify')!, 'v1');
  expect(initial.source).toBe(projectSkill);
  expect(initial.body).toBe('Project incumbent');
  await writeFile(projectSkill, '---\nname: verify\ndescription: verify\n---\nProject candidate');
  const cached = snapshotLoadedSkill(skills.activateSkill('verify')!, 'v1');
  expect(digest(cached)).toBe(digest(initial));
  skills.discoverSkills();
  const reloaded = snapshotLoadedSkill(skills.activateSkill('verify')!, 'v2');
  expect(reloaded.body).toBe('Project candidate');
  expect(digest(reloaded)).not.toBe(digest(initial));
});
