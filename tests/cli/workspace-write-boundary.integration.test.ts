import { afterEach, describe, expect, it } from 'vitest';
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

// The workspace write boundary, through the built CLI headlessly (profile bare, sandbox off, so no real
// sandbox is needed). A write that leaves the launch directory by any route must not happen unless the
// approval policy says so, and the reason the model is given must be the policy's, not an incidental
// failure. Every target is inside the test's own temp directory; the child's TMPDIR is a directory of its
// own, distinct from the workspace and from the outside targets (AGENTS.md, "Shell safety for agents").
//
// Not covered here: the OS sandbox that bounds shell writes when it is on (needs bubblewrap;
// cli.integration.scenarios.ts holds the one real-sandbox case), and a person answering the prompt
// (workspace-write-boundary.e2e.test.ts).

let world: World | undefined;
let provider: LoopbackProvider | undefined;

afterEach(async () => {
  await provider?.close();
  provider = undefined;
  removeWorld(world);
  world = undefined;
});

const NOT_APPROVED = 'Tool execution was not approved';
const HEADLESS_REASON = 'Non-interactive mode: use --auto-approve to allow tool execution';
const ORIGINAL = 'ORIGINAL\n';

type Call = { tool: string; args: Record<string, unknown> };
const create = (target: string): Call => ({ tool: 'create_file', args: { path: target, content: 'written\n' } });
const shell = (command: string): Call => ({ tool: 'shell', args: { command, description: 'Write the fixture file' } });

type Layout = { sibling: string; outsideAbs: string; outsideExisting: string };

/** What every case shares: a prefix-sharing sibling, an outside file, and symlinks out of the workspace. */
function layout(w: World): Layout {
  const sibling = `${w.workspace}-sibling`;
  fs.mkdirSync(sibling);
  const outsideExisting = path.join(w.outside, 'existing.txt');
  fs.writeFileSync(outsideExisting, ORIGINAL);
  fs.symlinkSync(w.outside, path.join(w.workspace, 'linkdir'));
  fs.symlinkSync(outsideExisting, path.join(w.workspace, 'linkfile.txt'));
  return { sibling, outsideAbs: path.join(w.outside, 'abs.txt'), outsideExisting };
}

async function run(options: {
  calls: (w: World, at: Layout) => Call[];
  settings?: Record<string, unknown>;
  reviewer?: ReviewerVerdict;
}) {
  world = createWorld('term2-boundary');
  const at = layout(world);
  const calls = options.calls(world, at);
  provider = await startLoopbackProvider({ turns: calls.map((call) => ({ call })), reviewer: options.reviewer });
  writeWorldSettings(world, provider.baseUrl, { sandbox: { enabled: false }, ...options.settings });
  const result = await runCli(world, integrationCliPath(), ['--profile', 'bare', 'Write the fixture files']);
  const requests = provider.requests();
  return {
    ...result,
    world,
    at,
    calls,
    requests,
    results: toolResults(requests.at(-1)),
    reviews: provider.reviews(),
  };
}

const exists = (target: string) => fs.existsSync(target);
const approvalRequests = (stderr: string) => stderr.match(/\[approval required\] \w+/g) ?? [];

describe('headless, approval mode off', () => {
  const escapes: { name: string; call: (w: World, at: Layout) => Call }[] = [
    { name: 'absolute path', call: (_w, at) => create(at.outsideAbs) },
    { name: '.. traversal', call: () => create('../outside/dotdot.txt') },
    {
      name: 'sibling directory that shares the workspace name as a prefix',
      call: (_w, at) => create(path.join(at.sibling, 'prefix.txt')),
    },
    { name: 'new file through a symlinked directory', call: () => create('linkdir/viadir.txt') },
    {
      name: 'edit of an outside file through a symlink in the workspace',
      call: () => ({
        tool: 'search_replace',
        args: { path: 'linkfile.txt', search_content: 'ORIGINAL', replace_content: 'CHANGED' },
      }),
    },
    {
      name: 'edit of an outside file by absolute path',
      call: (_w, at) => ({
        tool: 'search_replace',
        args: { path: at.outsideExisting, search_content: 'ORIGINAL', replace_content: 'CHANGED' },
      }),
    },
    { name: 'home directory by ~', call: () => create('~/tilde.txt') },
    { name: 'protected hooks directory inside the workspace', call: () => create('.term2/hooks/pre.sh') },
    { name: 'shell redirect with ..', call: () => shell('printf x > ../outside/shell-dotdot.txt') },
    { name: 'shell redirect to ~', call: () => shell('printf x > ~/shell-tilde.txt') },
    // Plain /tmp is outside the workspace (headless-approval-redesign.md, decision 4); the world lives under it.
    {
      name: 'shell redirect to plain /tmp outside the scratch area',
      call: (w) => shell(`printf x > ${path.join(w.outside, 'shell-tmp.txt')}`),
    },
  ];
  const controls: { name: string; call: (w: World) => Call }[] = [
    { name: 'relative path that stays inside', call: () => create('sub/../inside.txt') },
    { name: 'absolute path in the child scratch directory', call: (w) => create(path.join(w.scratch, 'scratch.txt')) },
    { name: 'shell redirect inside the workspace', call: () => shell('printf x > inside-shell.txt') },
    { name: 'shell redirect into $TMPDIR', call: () => shell('printf x > "$TMPDIR/shell-scratch.txt"') },
    // Only writes to plain /tmp are outside: an input redirect from it is a read and runs.
    {
      name: 'shell input redirect from plain /tmp',
      call: (w) => shell(`wc -c < ${path.join(w.outside, 'existing.txt')}`),
    },
  ];

  it('refuses every write that leaves the workspace and runs the ones that do not', { timeout: 30_000 }, async () => {
    const result = await run({
      calls: (w, at) => [...escapes.map((e) => e.call(w, at)), ...controls.map((c) => c.call(w))],
    });
    const { world: w, at } = result;
    expect(result.status, result.stderr).toBe(0);
    expect(result.results).toHaveLength(escapes.length + controls.length);
    // The /tmp case is only an escape from the scratch area when the world itself is under /tmp.
    expect(w.outside.startsWith('/tmp/'), 'test worlds live under /tmp').toBe(true);

    // Each escape was held for approval and answered no by the headless policy: that is the reason given.
    escapes.forEach((escape, index) => {
      expect(result.results[index]?.text, escape.name).toContain(NOT_APPROVED);
      expect(result.results[index]?.text, escape.name).toContain(HEADLESS_REASON);
    });
    expect(approvalRequests(result.stderr)).toHaveLength(escapes.length);

    // Nothing was created or changed outside the workspace.
    expect(fs.readdirSync(w.outside)).toEqual(['existing.txt']);
    expect(fs.readFileSync(at.outsideExisting, 'utf8')).toBe(ORIGINAL);
    expect(fs.readdirSync(at.sibling)).toEqual([]);
    expect(exists(path.join(w.home, 'tilde.txt'))).toBe(false);
    expect(exists(path.join(w.home, 'shell-tilde.txt'))).toBe(false);
    const tmpIndex = escapes.findIndex((escape) => escape.name.startsWith('shell redirect to plain /tmp'));
    expect(result.results[tmpIndex]?.text, 'names the scratch area').toContain('Use $TMPDIR');
    expect(exists(path.join(w.workspace, '.term2', 'hooks', 'pre.sh'))).toBe(false);

    // The controls ran without being held, so the refusals above are not a blanket refusal.
    controls.forEach((control, index) => {
      expect(result.results[escapes.length + index]?.text, control.name).not.toContain(NOT_APPROVED);
    });
    expect(fs.readFileSync(path.join(w.workspace, 'inside.txt'), 'utf8')).toBe('written\n');
    expect(fs.readFileSync(path.join(w.scratch, 'scratch.txt'), 'utf8')).toBe('written\n');
    expect(fs.readFileSync(path.join(w.workspace, 'inside-shell.txt'), 'utf8')).toBe('x');
    expect(fs.readFileSync(path.join(w.scratch, 'shell-scratch.txt'), 'utf8')).toBe('x');
  });
});

describe('headless, a reviewer model decides', () => {
  const rejects: ReviewerVerdict = { approve: false, reasoning: 'REVIEWER-SAYS-NO' };
  const approves: ReviewerVerdict = { approve: true, reasoning: 'REVIEWER-SAYS-YES' };

  /** The reviewer was shown the outside target and told what the call is. */
  function expectReviewerSawOutsideWrite(reviews: { messages: { content?: unknown }[] }[], target: string) {
    expect(reviews).toHaveLength(1);
    const shown = JSON.stringify(reviews[0]?.messages.at(-1)?.content);
    expect(shown).toContain(target);
    expect(shown).toContain('create / overwrite file outside workspace');
  }

  it('auto: a rejected outside write is refused and says why; an inside write is never reviewed', async () => {
    const result = await run({
      calls: (w, at) => [create('inside.txt'), create(at.outsideAbs)],
      settings: { shell: { autoApproveMode: 'auto' } },
      reviewer: rejects,
    });
    expect(result.status, result.stderr).toBe(0);
    expectReviewerSawOutsideWrite(result.reviews, result.at.outsideAbs);
    expect(result.results[0]?.text).toContain('Created inside.txt');
    expect(result.results[1]?.text).toContain(NOT_APPROVED);
    expect(result.results[1]?.text).toContain('REVIEWER-SAYS-NO');
    expect(exists(result.at.outsideAbs)).toBe(false);
    expect(approvalRequests(result.stderr)).toEqual(['[approval required] create_file']);
  });

  it('auto: the reviewer is what decides, so an approved outside write is made', async () => {
    const result = await run({
      calls: (w, at) => [create(at.outsideAbs)],
      settings: { shell: { autoApproveMode: 'auto' } },
      reviewer: approves,
    });
    expect(result.status, result.stderr).toBe(0);
    expectReviewerSawOutsideWrite(result.reviews, result.at.outsideAbs);
    expect(fs.readFileSync(result.at.outsideAbs, 'utf8')).toBe('written\n');
  });

  it('unattended: a rejected outside write is refused by policy, naming the call and the reviewer', async () => {
    const result = await run({
      calls: (w, at) => [create(at.outsideAbs)],
      settings: { shell: { autoApproveMode: 'unattended' } },
      reviewer: rejects,
    });
    expect(result.status, result.stderr).toBe(0);
    expectReviewerSawOutsideWrite(result.reviews, result.at.outsideAbs);
    const text = result.results[0]?.text ?? '';
    expect(text).toContain('Refused by unattended approval (no person is available to approve): create_file');
    expect(text).toContain(result.at.outsideAbs);
    expect(text).toContain('the approval reviewer did not approve it: REVIEWER-SAYS-NO');
    expect(exists(result.at.outsideAbs)).toBe(false);
  });

  it('unattended: an outside edit through a symlink is reviewed as an outside write, not waved through', async () => {
    const result = await run({
      calls: () => [create('linkdir/viadir.txt')],
      settings: { shell: { autoApproveMode: 'unattended' } },
      reviewer: rejects,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.reviews).toHaveLength(1);
    expect(result.results[0]?.text).toContain('Refused by unattended approval');
    expect(exists(path.join(result.world.outside, 'viadir.txt'))).toBe(false);
  });

  it('always: asks nobody, by design, and the outside write is made', async () => {
    const result = await run({
      calls: (w, at) => [create(at.outsideAbs)],
      settings: { shell: { autoApproveMode: 'always' } },
      reviewer: rejects,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.reviews).toHaveLength(0);
    expect(approvalRequests(result.stderr)).toHaveLength(0);
    expect(fs.readFileSync(result.at.outsideAbs, 'utf8')).toBe('written\n');
  });
});
