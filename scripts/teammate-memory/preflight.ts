import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryCapabilityBuilder } from '../../source/services/memory/memory-capabilities.js';
import { FileMemoryStore } from '../../source/services/memory/memory-store.js';
import { createMockSettingsService } from '../../source/services/settings/settings-service.mock.js';

const SNAPSHOT = 'a1142650';
const QUERY = 'The nested Codex 400s are back. What is the smallest next diagnostic and what should we avoid changing?';
const BUDGET = 800;

async function archiveInto(ref: string, directory: string): Promise<void> {
  await new Promise<void>((done, fail) => {
    const archive = spawn('git', ['archive', ref], { stdio: ['ignore', 'pipe', 'pipe'] });
    const extract = spawn('tar', ['-x', '-C', directory], { stdio: ['pipe', 'ignore', 'pipe'] });
    archive.stdout.pipe(extract.stdin);
    let archiveError = '';
    let extractError = '';
    archive.stderr.on('data', (data) => (archiveError += String(data)));
    extract.stderr.on('data', (data) => (extractError += String(data)));
    archive.on('error', fail);
    extract.on('error', fail);
    let archiveCode: number | null = null;
    let extractCode: number | null = null;
    const finish = () => {
      if (archiveCode === null || extractCode === null) return;
      if (archiveCode || extractCode) fail(new Error(`Snapshot extraction failed: ${archiveError} ${extractError}`));
      else done();
    };
    archive.on('close', (code) => {
      archiveCode = code ?? -1;
      finish();
    });
    extract.on('close', (code) => {
      extractCode = code ?? -1;
      finish();
    });
  });
}

export async function prepareR1(outputDirectory: string) {
  const parent = execFileSync('git', ['rev-parse', 'eb38e6f7^'], { encoding: 'utf8' }).trim();
  const snapshotCommit = execFileSync('git', ['rev-parse', SNAPSHOT], { encoding: 'utf8' }).trim();
  if (parent !== snapshotCommit) throw new Error('R1 snapshot no longer matches the recorded parent');
  const output = resolve(outputDirectory);
  await mkdir(output); // Never overwrite or reset a prior run.
  const projectIds: Record<'A' | 'B', string> = { A: '', B: '' };
  const contexts: Record<'A' | 'B', string> = { A: '', B: '' };
  for (const arm of ['A', 'B'] as const) {
    const directory = join(output, arm);
    const workspace = join(directory, 'workspace');
    const memory = join(directory, 'memory');
    const sessions = join(directory, 'sessions');
    await mkdir(workspace, { recursive: true });
    await mkdir(memory);
    await mkdir(sessions);
    await archiveInto(snapshotCommit, workspace);
    // An archive has no .git, so the production resolver uses the workspace path as project ID.
    const projectId = createHash('sha256').update(workspace).digest('hex');
    projectIds[arm] = projectId;
    const store = new FileMemoryStore({
      root: join(memory, 'projects', projectId),
      now: (() => {
        let tick = 0;
        return () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
      })(),
    });
    await store.create({
      id: 'nested-chain',
      title: 'Codex nested-chain incident',
      summary: 'Child runs need distinct physical WebSocket identity; preserve root cache affinity and chaining.',
      content:
        'Child runs need their own physical WebSocket identity even if the logical session is shared. Keep root cache affinity; do not disable chaining.',
    });
    for (let i = 0; i < 25; i++) {
      await store.create({
        id: `release-${i}`,
        title: 'Release notes',
        summary: 'Unrelated release-note and menu work.',
        content: 'No socket decision.',
      });
    }
    const settings = createMockSettingsService({
      'memory.directory': memory,
      'memory.contextBudgetChars': BUDGET,
    });
    const builder = new MemoryCapabilityBuilder(settings);
    contexts[arm] =
      arm === 'A'
        ? builder.build({ kind: 'main' }, { projectPath: workspace }).context
        : await builder.contextForTurn(QUERY, { projectPath: workspace });
  }
  const valid =
    !contexts.A.includes('distinct physical WebSocket') &&
    contexts.B.includes('distinct physical WebSocket') &&
    !contexts.B.includes('Unrelated release-note');
  const manifest = {
    status: 'offline-preflight-only',
    valid,
    snapshot: SNAPSHOT,
    snapshotCommit,
    runtimeRefs: { A: '657b5425', B: '91b58452' },
    model: 'codex/gpt-6-luna',
    effort: 'medium',
    budgetChars: BUDGET,
    projectIds,
    aContext: contexts.A,
    bContext: contexts.B,
    plannedCapsNotEnforced: { requestsPerArm: 12, wallMinutesPerArm: 15, estimatedUsdPerArm: 0.5 },
    acceptance:
      'R1 pass requires applying prior decision without re-explanation or disabling chaining; inspect full tool and response trace and billed usage. One cell is not an efficacy result.',
    blocker:
      'No faithful multi-session provider runner or enforceable spend guard yet; do not launch paid calls from this preflight.',
  };
  await writeFile(join(output, 'preflight.json'), JSON.stringify(manifest, null, 2) + '\n');
  if (!valid) throw new Error('R1 retrieval contrast invalid; inspect preflight.json');
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3)
    throw new Error('Usage: pnpm exec tsx scripts/teammate-memory/preflight.ts <new-output-directory>');
  prepareR1(process.argv[2]).then(
    (result) => console.log(JSON.stringify({ valid: result.valid, snapshot: result.snapshotCommit })),
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
