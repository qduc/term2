import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { integrationCliPath } from '../helpers/integration-cli.js';
import {
  createWorld,
  removeWorld,
  runCli,
  startLoopbackProvider,
  toolResults,
  writeWorldSettings,
  type LoopbackProvider,
  type ReviewerVerdict,
  type World,
} from '../helpers/loopback-chat-world.js';

// Headless never asks (docs/plans/approvals-and-sandbox/headless-approval-redesign.md, decisions 1 and 2).
// `--auto-approve` selects mode `auto`: the approval reviewer decides what `off` would have asked about, and
// what it does not approve is refused. Before, a second policy (`NonInteractiveApprovalPolicy`) approved every
// non-shell tool on its own, so an outside write the reviewer had rejected was still made
// (support-tier-gaps.md, item 4). Built CLI, headless, sandbox off, a loopback model and reviewer.

let world: World | undefined;
let provider: LoopbackProvider | undefined;

afterEach(async () => {
  await provider?.close();
  provider = undefined;
  removeWorld(world);
  world = undefined;
});

async function writeOutside(args: string[], reviewer: ReviewerVerdict, settings: Record<string, unknown> = {}) {
  world = createWorld('term2-headless-auto');
  const w = world;
  const target = path.join(w.outside, 'written.txt');
  provider = await startLoopbackProvider({
    turns: [
      { call: { tool: 'create_file', args: { path: target, content: 'x\n' } } },
      { call: { tool: 'create_file', args: { path: 'inside.txt', content: 'x\n' } } },
    ],
    reviewer,
  });
  writeWorldSettings(w, provider.baseUrl, { sandbox: { enabled: false }, ...settings });
  const result = await runCli(w, integrationCliPath(), ['--profile', 'bare', ...args, 'Write the files']);
  const report = `exit ${result.status}\nstderr:\n${result.stderr}`;
  expect(result.status, report).toBe(0);
  const results = toolResults(provider.requests().at(-1)).map((entry) => entry.text);
  expect(results, report).toHaveLength(2);
  // The inside write never needs approval, whatever the flags.
  expect(results[1], report).toContain('Created inside.txt');
  return { results, written: fs.existsSync(target), reviews: provider.reviews(), report };
}

const rejects: ReviewerVerdict = { approve: false, reasoning: 'REVIEWER-SAYS-NO' };
const approves: ReviewerVerdict = { approve: true, reasoning: 'REVIEWER-SAYS-YES' };

it('--auto-approve: an outside write the reviewer rejects is refused and names the review', async () => {
  const run = await writeOutside(['--auto-approve'], rejects);
  expect(run.reviews, run.report).toHaveLength(1);
  expect(run.written, run.report).toBe(false);
  expect(run.results[0]).toContain('Tool execution was not approved');
  expect(run.results[0]).toContain('No person is available to approve this in a non-interactive run.');
  expect(run.results[0]).toContain('REVIEWER-SAYS-NO');
});

it('--auto-approve: an outside write the reviewer approves is made', async () => {
  const run = await writeOutside(['--auto-approve'], approves);
  expect(run.reviews, run.report).toHaveLength(1);
  expect(run.written, run.report).toBe(true);
});

it('no flags: the outside write is refused without a review', async () => {
  const run = await writeOutside([], approves);
  expect(run.reviews, run.report).toHaveLength(0);
  expect(run.written, run.report).toBe(false);
  expect(run.results[0]).toContain('Non-interactive mode: use --auto-approve to allow tool execution');
});

it('--auto-approve keeps a saved always: the outside write is made without a review', async () => {
  const run = await writeOutside(['--auto-approve'], rejects, { shell: { autoApproveMode: 'always' } });
  expect(run.reviews, run.report).toHaveLength(0);
  expect(run.written, run.report).toBe(true);
});
