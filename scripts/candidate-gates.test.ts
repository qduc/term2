import { expect, it, vi } from 'vitest';
import {
  EXIT_CODES,
  buildPnpmGate,
  collectTouchSet,
  createDefaultRunner,
  lintBriefHeadings,
  main,
  parseArguments,
  readBoundedFile,
  runCandidateGates,
  serializeBoundedJson,
  trimOutput,
  type CommandInvocation,
  type CommandResult,
  type GateName,
} from './candidate-gates.js';

function successful(stdout = ''): CommandResult {
  return { exitCode: 0, stdout, stderr: '', timedOut: false };
}

function fakeRunner(results: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>) {
  const calls: CommandInvocation[] = [];
  const runner = async (invocation: CommandInvocation) => {
    calls.push(invocation);
    return results(invocation);
  };
  return { calls, runner };
}

it('parses repeated allowlist, gate, and heading arguments without accepting arbitrary commands', () => {
  expect(
    parseArguments([
      '--worktree',
      '/tmp/candidate',
      '--primary',
      '/tmp/primary',
      '--branch',
      'candidate-gates-tooling',
      '--base',
      'main',
      '--allow',
      'scripts/candidate-gates.ts',
      '--allow-prefix',
      'scripts/provider-black-box/',
      '--gate',
      'test',
      '--gate',
      'typecheck',
      '--gate',
      'script-typecheck',
      '--require-heading',
      'Objective',
    ]),
  ).toEqual({
    worktree: '/tmp/candidate',
    primary: '/tmp/primary',
    branch: 'candidate-gates-tooling',
    base: 'main',
    baseCommit: undefined,
    allowExact: ['scripts/candidate-gates.ts'],
    allowPrefixes: ['scripts/provider-black-box/'],
    gates: ['test', 'typecheck', 'script-typecheck'],
    timeoutMs: 30_000,
    maxOutputBytes: 20_000,
    brief: undefined,
    requiredHeadings: ['Objective'],
    evidence: undefined,
    evidenceFile: undefined,
  });
});

it('constructs only fixed pnpm gates and marks test gates with NODE_ENV=test', () => {
  expect(buildPnpmGate('test', '/tmp/candidate')).toEqual({
    command: 'pnpm',
    args: ['--dir', '/tmp/candidate', 'test'],
    env: { NODE_ENV: 'test' },
  });
  expect(buildPnpmGate('script-typecheck', '/tmp/candidate')).toEqual({
    command: 'pnpm',
    args: [
      '--dir',
      '/tmp/candidate',
      'exec',
      'tsc',
      '--ignoreConfig',
      '--noEmit',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--strict',
      '--esModuleInterop',
      '--skipLibCheck',
      '--types',
      'node',
      'scripts/candidate-gates.ts',
      'scripts/candidate-gates.test.ts',
    ],
    env: {},
  });
  expect(buildPnpmGate('typecheck', '/tmp/candidate')).toEqual({
    command: 'pnpm',
    args: ['--dir', '/tmp/candidate', 'typecheck'],
    env: {},
  });
  expect(buildPnpmGate('format', '/tmp/candidate', ['scripts/candidate-gates.ts'])).toEqual({
    command: 'pnpm',
    args: ['--dir', '/tmp/candidate', 'exec', 'prettier', '--check', '--', 'scripts/candidate-gates.ts'],
    env: {},
  });
  expect(
    buildPnpmGate('test', '/tmp/candidate', [
      'docs/brief.md',
      'source/app.ts',
      'scripts/fixture.test.ts',
      '--config=bad.test.ts',
    ]),
  ).toEqual({
    command: 'pnpm',
    args: ['--dir', '/tmp/candidate', 'test', 'scripts/fixture.test.ts', './--config=bad.test.ts'],
    env: { NODE_ENV: 'test' },
  });
  expect(buildPnpmGate('test', '/tmp/candidate', ['docs/brief.md', 'source/app.ts']).args).toEqual([
    '--dir',
    '/tmp/candidate',
    'test',
  ]);
  expect(() => buildPnpmGate('not-a-gate' as GateName, '/tmp/candidate')).toThrow(/Unsupported gate/);
});

it('exposes only fixed, non-mutating pnpm gates', () => {
  expect(() => buildPnpmGate('not-a-gate' as GateName, '/tmp/candidate')).toThrow(/Unsupported gate/);
  expect(() =>
    buildPnpmGate(
      { name: 'unsafe', argv: ['exec', 'sh', '-c', 'touch outside'] } as unknown as GateName,
      '/tmp/candidate',
    ),
  ).toThrow(/Unsupported gate/);
});

it('rejects absolute and traversal allowlist entries at argv boundaries', () => {
  const base = ['--worktree', '/tmp/candidate', '--primary', '/tmp/primary', '--branch', 'candidate', '--base', 'main'];
  expect(() => parseArguments([...base, '--allow', '/etc/passwd'])).toThrow(/repo-relative/);
  expect(() => parseArguments([...base, '--allow-prefix', '../source/'])).toThrow(/repo-relative/);
  expect(() => parseArguments([...base, '--allow', 'C:/outside'])).toThrow(/repo-relative/);
});

it('collects committed, staged, unstaged, and untracked paths as one sorted touch set', async () => {
  const { calls, runner } = fakeRunner((invocation) => {
    const key = invocation.args.join(' ');
    if (key.includes('HEAD')) return successful('source/committed.ts\nshared/name with spaces.ts\n');
    if (key.includes('--cached')) return successful('scripts/staged.ts\n');
    if (key === 'diff --name-only') return successful('source/unstaged.ts\nshared/name with spaces.ts\n');
    if (key.includes('ls-files')) return successful('scripts/new.ts\n');
    throw new Error(`unexpected git invocation: ${key}`);
  });

  await expect(collectTouchSet({ runner, cwd: '/tmp/candidate', base: 'main' })).resolves.toEqual([
    'scripts/new.ts',
    'scripts/staged.ts',
    'shared/name with spaces.ts',
    'source/committed.ts',
    'source/unstaged.ts',
  ]);
  expect(calls).toHaveLength(4);
});

it('rejects unsafe base refs at the exported touch-set boundary', async () => {
  const { runner } = fakeRunner(() => successful());
  await expect(collectTouchSet({ runner, cwd: '/tmp/candidate', base: '--config=bad' })).rejects.toThrow(
    /Unsafe git ref/,
  );
});

it('truncates text only at valid UTF-8 boundaries', () => {
  expect(trimOutput('éx', 2)).toEqual({ value: 'é', truncated: true });
  expect(Buffer.byteLength(trimOutput('😀x', 3).value, 'utf8')).toBe(0);
});

it('drops an incomplete file suffix without exceeding the byte bound', async () => {
  const source = Buffer.from('a😀tail', 'utf8');
  const result = await readBoundedFile('ignored', 2, async () => ({
    read: async (buffer: Buffer, _offset: number, length: number) => {
      source.copy(buffer, 0, 0, Math.min(length, source.length));
      return { bytesRead: Math.min(length, source.length) };
    },
    close: async () => {},
  }));
  expect(result).toEqual({ value: 'a', truncated: true });
  expect(Buffer.byteLength(result.value, 'utf8')).toBeLessThanOrEqual(2);
  expect(Buffer.from(result.value, 'utf8').toString('utf8')).toBe(result.value);
});

it('reads only a bounded UTF-8 prefix from a file and closes the handle', async () => {
  const source = Buffer.from('😀tail', 'utf8');
  let requestedLength = 0;
  let closed = false;
  const result = await readBoundedFile('ignored', 4, async () => ({
    read: async (buffer: Buffer, _offset: number, length: number) => {
      requestedLength = length;
      source.copy(buffer, 0, 0, Math.min(length, source.length));
      return { bytesRead: Math.min(length, source.length) };
    },
    close: async () => {
      closed = true;
    },
  }));
  expect(requestedLength).toBe(5);
  expect(result).toEqual({ value: '😀', truncated: true });
  expect(closed).toBe(true);
});

it('bounds the complete JSON result while preserving classification', () => {
  const result = serializeBoundedJson({ ok: false, classification: 'scope-failed', payload: 'x'.repeat(200_000) });
  expect(result.truncated).toBe(true);
  expect(Buffer.byteLength(result.value, 'utf8')).toBeLessThanOrEqual(99_999);
  expect(JSON.parse(result.value)).toMatchObject({
    ok: false,
    classification: 'scope-failed',
    truncated: true,
  });
});

it('rejects inherited classification names in bounded JSON', () => {
  const result = serializeBoundedJson({ classification: 'toString', payload: 'x'.repeat(200_000) });
  expect(result.truncated).toBe(true);
  expect(JSON.parse(result.value).classification).toBe('invalid-input');
});

it('lints required markdown headings as a pure function', () => {
  expect(lintBriefHeadings('# Objective\n\n## Scope\n\nText', ['Objective', 'Scope'])).toEqual({
    ok: true,
    headings: ['Objective', 'Scope'],
    missing: [],
    truncated: false,
  });
  expect(lintBriefHeadings('# Objective\n', ['Objective', 'Acceptance criteria'])).toEqual({
    ok: false,
    headings: ['Objective'],
    missing: ['Acceptance criteria'],
    truncated: false,
  });
});

it('requires a brief when headings are requested and bounds evidence, text, lists, and gate output', async () => {
  const { runner } = fakeRunner((invocation) => {
    const key = invocation.args.join(' ');
    if (invocation.command === 'git' && key === 'worktree list --porcelain') {
      return successful(
        'worktree /canonical/primary\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main\n\n' +
          'worktree /canonical/candidate\nHEAD 2222222222222222222222222222222222222222\nbranch refs/heads/candidate\n',
      );
    }
    if (invocation.command === 'git' && key === 'branch --show-current') return successful('candidate\n');
    if (invocation.command === 'git' && key === 'rev-parse --verify main^{commit}')
      return successful('1111111111111111111111111111111111111111\n');
    if (invocation.command === 'git' && key === 'merge-base HEAD main')
      return successful('1111111111111111111111111111111111111111\n');
    if (invocation.command === 'git') return successful('scripts/allowed-file.ts\nscripts/another-long-file.ts\n');
    return {
      exitCode: 0,
      stdout: 'output '.repeat(100),
      stderr: 'error '.repeat(100),
      timedOut: false,
      stdoutTruncated: true,
    };
  });

  const base = {
    worktree: '/tmp/candidate',
    primary: '/tmp/primary',
    branch: 'candidate',
    base: 'main',
    allowExact: [],
    allowPrefixes: ['scripts/'],
    gates: ['test'] as const,
    runner,
    pathExists: async () => true,
    realpath: async (value: string) => value.replace('/tmp/', '/canonical/'),
    maxOutputBytes: 40,
  };
  const missingBrief = await runCandidateGates({ ...base, requiredHeadings: ['Objective'] });
  expect(missingBrief.classification).toBe('contract-failed');
  expect(missingBrief.checks.brief).toBe(false);

  const report = await runCandidateGates({
    ...base,
    evidenceCollector: async () => ({
      status: 's'.repeat(1000),
      settlement: 't'.repeat(1000),
      text: 'x'.repeat(1000),
    }),
    brief: '/canonical/brief.md',
    requiredHeadings: ['Objective'],
    readFile: async () => '# Objective\n'.repeat(100),
  });
  expect(report.schemaVersion).toBe(1);
  expect(report.head).toBe('2222222222222222222222222222222222222222');
  expect(report.worktree).toBe('/canonical/candidate');
  expect(report.touchSetTruncated).toBe(true);
  expect(report.touchSetTotal).toBeGreaterThan(report.touchSet.length);
  expect(String(report.evidence?.status).length).toBeLessThanOrEqual(256);
  expect(String(report.evidence?.settlement).length).toBeLessThanOrEqual(256);
  expect(report.evidence?.truncated).toBe(true);
  expect(report.evidenceTruncated).toBe(true);
  expect(report.brief?.truncated).toBe(true);
  expect(report.gates[0]?.truncated).toBe(true);
});

it('validates the registered absolute non-primary worktree, exact branch/base, allowlist, and runs every gate sequentially', async () => {
  const invocations: CommandInvocation[] = [];
  const { runner } = fakeRunner((invocation) => {
    invocations.push(invocation);
    const key = invocation.args.join(' ');
    if (invocation.command === 'git' && key === 'worktree list --porcelain') {
      return successful(
        'worktree /tmp/primary\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main\n\n' +
          'worktree /tmp/candidate\nHEAD 2222222222222222222222222222222222222222\nbranch refs/heads/candidate-gates-tooling\n',
      );
    }
    if (invocation.command === 'git' && key === 'branch --show-current') return successful('candidate-gates-tooling\n');
    if (invocation.command === 'git' && key === 'rev-parse --verify main^{commit}')
      return successful('1111111111111111111111111111111111111111\n');
    if (invocation.command === 'git' && key === 'merge-base HEAD main')
      return successful('1111111111111111111111111111111111111111\n');
    if (invocation.command === 'git' && key.includes('diff --name-only') && key.includes('main...HEAD'))
      return successful('scripts/candidate-gates.ts\n');
    if (invocation.command === 'git' && key.includes('--cached')) return successful('');
    if (invocation.command === 'git' && key === 'diff --name-only')
      return successful('scripts/candidate-gates.test.ts\n');
    if (invocation.command === 'git' && key.includes('ls-files')) return successful('');
    if (invocation.command === 'pnpm') return successful(`ran ${key}`);
    throw new Error(`unexpected invocation: ${invocation.command} ${key}`);
  });

  const report = await runCandidateGates({
    worktree: '/tmp/candidate',
    primary: '/tmp/primary',
    branch: 'candidate-gates-tooling',
    base: 'main',
    allowExact: [],
    allowPrefixes: ['scripts/'],
    gates: ['test', 'script-typecheck', 'format'],
    runner,
    pathExists: async () => true,
    realpath: async (value) => value,
    evidence: { source: 'injected', note: 'worker result' },
  });

  expect(report.ok).toBe(true);
  expect(report.classification).toBe('pass');
  expect(report.touchSet).toEqual(['scripts/candidate-gates.test.ts', 'scripts/candidate-gates.ts']);
  expect(report.gates.map((gate) => gate.name)).toEqual(['test', 'script-typecheck', 'format']);
  expect(report.evidence).toEqual({ source: 'injected', note: 'worker result' });
  expect(
    invocations.filter((invocation) => invocation.command === 'pnpm').map((invocation) => invocation.args),
  ).toEqual([
    ['--dir', '/tmp/candidate', 'test', 'scripts/candidate-gates.test.ts'],
    [
      '--dir',
      '/tmp/candidate',
      'exec',
      'tsc',
      '--ignoreConfig',
      '--noEmit',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--strict',
      '--esModuleInterop',
      '--skipLibCheck',
      '--types',
      'node',
      'scripts/candidate-gates.ts',
      'scripts/candidate-gates.test.ts',
    ],
    [
      '--dir',
      '/tmp/candidate',
      'exec',
      'prettier',
      '--check',
      '--',
      'scripts/candidate-gates.test.ts',
      'scripts/candidate-gates.ts',
    ],
  ]);
  expect(invocations.find((invocation) => invocation.command === 'pnpm')?.env).toMatchObject({ NODE_ENV: 'test' });
});

it('falls back to the full test suite when every touched test path is deleted', async () => {
  const pnpmCalls: CommandInvocation[] = [];
  const { runner } = fakeRunner((invocation) => {
    const key = invocation.args.join(' ');
    if (invocation.command === 'git' && key === 'worktree list --porcelain') {
      return successful(
        'worktree /tmp/primary\nHEAD 1\nbranch refs/heads/main\n\n' +
          'worktree /tmp/candidate\nHEAD 2\nbranch refs/heads/candidate\n',
      );
    }
    if (invocation.command === 'git' && key === 'branch --show-current') return successful('candidate\n');
    if (invocation.command === 'git' && key === 'rev-parse --verify main^{commit}') return successful('1\n');
    if (invocation.command === 'git' && key === 'merge-base HEAD main') return successful('1\n');
    if (invocation.command === 'git' && key.includes('main...HEAD')) return successful('tests/deleted.test.ts\n');
    if (invocation.command === 'git') return successful('');
    pnpmCalls.push(invocation);
    return successful();
  });

  const report = await runCandidateGates({
    worktree: '/tmp/candidate',
    primary: '/tmp/primary',
    branch: 'candidate',
    base: 'main',
    allowExact: [],
    allowPrefixes: ['tests/'],
    gates: ['test'],
    runner,
    pathExists: async () => false,
    realpath: async (value) => value,
  });

  expect(report.ok).toBe(true);
  expect(pnpmCalls[0]?.args).toEqual(['--dir', '/tmp/candidate', 'test']);
});

it('keeps deleted paths in scope while passing only existing option-like tests to gates', async () => {
  const pnpmCalls: CommandInvocation[] = [];
  const { runner } = fakeRunner((invocation) => {
    const key = invocation.args.join(' ');
    if (invocation.command === 'git' && key === 'worktree list --porcelain') {
      return successful(
        'worktree /tmp/primary\nHEAD 1\nbranch refs/heads/main\n\n' +
          'worktree /tmp/candidate\nHEAD 2\nbranch refs/heads/candidate\n',
      );
    }
    if (invocation.command === 'git' && key === 'branch --show-current') return successful('candidate\n');
    if (invocation.command === 'git' && key === 'rev-parse --verify main^{commit}') return successful('1\n');
    if (invocation.command === 'git' && key === 'merge-base HEAD main') return successful('1\n');
    if (invocation.command === 'git' && key.includes('main...HEAD')) return successful('deleted.test.ts\n');
    if (invocation.command === 'git' && key.includes('ls-files')) return successful('--option.test.ts\n');
    if (invocation.command === 'git') return successful('');
    pnpmCalls.push(invocation);
    return successful();
  });

  const report = await runCandidateGates({
    worktree: '/tmp/candidate',
    primary: '/tmp/primary',
    branch: 'candidate',
    base: 'main',
    allowExact: ['deleted.test.ts', '--option.test.ts'],
    allowPrefixes: [],
    gates: ['test', 'format'],
    runner,
    pathExists: async (file) => file.endsWith('--option.test.ts'),
    realpath: async (value) => value,
  });

  expect(report.classification).toBe('pass');
  expect(report.touchSet).toEqual(['--option.test.ts', 'deleted.test.ts']);
  expect(report.scopeViolations).toEqual([]);
  expect(pnpmCalls.map((call) => call.args)).toEqual([
    ['--dir', '/tmp/candidate', 'test', './--option.test.ts'],
    ['--dir', '/tmp/candidate', 'exec', 'prettier', '--check', '--', './--option.test.ts'],
  ]);
});

it('reports scope failures without invoking gates', async () => {
  const { calls, runner } = fakeRunner((invocation) => {
    const key = invocation.args.join(' ');
    if (key === 'worktree list --porcelain') {
      return successful(
        'worktree /tmp/primary\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main\n\n' +
          'worktree /tmp/candidate\nHEAD 2222222222222222222222222222222222222222\nbranch refs/heads/candidate\n',
      );
    }
    if (key === 'branch --show-current') return successful('candidate\n');
    if (key === 'rev-parse --verify main^{commit}') return successful('1111111111111111111111111111111111111111\n');
    if (key === 'merge-base HEAD main') return successful('1111111111111111111111111111111111111111\n');
    if (key.includes('main...HEAD')) return successful('source/forbidden.ts\n');
    if (key.includes('--cached') || key === 'diff --name-only') return successful('');
    if (key.includes('ls-files')) return successful('');
    throw new Error(`unexpected invocation: ${key}`);
  });

  const report = await runCandidateGates({
    worktree: '/tmp/candidate',
    primary: '/tmp/primary',
    branch: 'candidate',
    base: 'main',
    allowExact: ['scripts/candidate-gates.ts'],
    allowPrefixes: [],
    gates: ['test'],
    runner,
    realpath: async (value) => value,
  });

  expect(report.ok).toBe(false);
  expect(report.classification).toBe('scope-failed');
  expect(report.scopeViolations).toEqual(['source/forbidden.ts']);
  expect(calls.some((call) => call.command === 'pnpm')).toBe(false);
});

it('rejects timeout values beyond the Node timer range at both input boundaries', async () => {
  const base = ['--worktree', '/tmp/candidate', '--primary', '/tmp/primary', '--branch', 'candidate', '--base', 'main'];
  expect(() => parseArguments([...base, '--timeout-ms', '2147483648'])).toThrow(/at most/);

  const report = await runCandidateGates({
    worktree: '/tmp/candidate',
    primary: '/tmp/primary',
    branch: 'candidate',
    base: 'main',
    allowExact: [],
    allowPrefixes: [],
    gates: ['test'],
    timeoutMs: 2_147_483_648,
  });
  expect(report.classification).toBe('contract-failed');
  expect(report.errors).toContain('timeout and output bounds must be positive integers');
});

it('classifies unregistered worktrees, wrong branches, and wrong bases before gates', async () => {
  const scenarios = [
    {
      name: 'unregistered',
      registry: 'worktree /tmp/primary\nHEAD 1\nbranch refs/heads/main\n',
      branch: 'candidate',
      mergeBase: '1',
    },
    {
      name: 'wrong branch',
      registry:
        'worktree /tmp/primary\nHEAD 1\nbranch refs/heads/main\n\nworktree /tmp/candidate\nHEAD 2\nbranch refs/heads/other\n',
      branch: 'candidate',
      mergeBase: '1',
    },
    {
      name: 'wrong base',
      registry:
        'worktree /tmp/primary\nHEAD 1\nbranch refs/heads/main\n\nworktree /tmp/candidate\nHEAD 2\nbranch refs/heads/candidate\n',
      branch: 'candidate',
      mergeBase: 'different',
    },
  ];
  for (const scenario of scenarios) {
    const { calls, runner } = fakeRunner((invocation) => {
      const key = invocation.args.join(' ');
      if (key === 'worktree list --porcelain') return successful(scenario.registry);
      if (key === 'branch --show-current') return successful(`${scenario.branch}\n`);
      if (key === 'rev-parse --verify main^{commit}') return successful('1\n');
      if (key === 'merge-base HEAD main') return successful(`${scenario.mergeBase}\n`);
      throw new Error(`gate should not run for ${scenario.name}`);
    });
    const report = await runCandidateGates({
      worktree: '/tmp/candidate',
      primary: '/tmp/primary',
      branch: 'candidate',
      base: 'main',
      allowExact: [],
      allowPrefixes: [],
      gates: ['test'],
      runner,
      realpath: async (value) => value,
    });
    expect(report.classification, scenario.name).toBe('contract-failed');
    expect(
      calls.some((call) => call.command === 'pnpm'),
      scenario.name,
    ).toBe(false);
  }
});

it('rejects a canonical primary subdirectory that is not itself registered', async () => {
  const { calls, runner } = fakeRunner((invocation) => {
    const key = invocation.args.join(' ');
    if (key === 'worktree list --porcelain') {
      return successful(
        'worktree /actual/primary\nHEAD 1\nbranch refs/heads/main\n\n' +
          'worktree /tmp/candidate\nHEAD 2\nbranch refs/heads/candidate\n',
      );
    }
    throw new Error('primary registration should fail before other commands');
  });
  const report = await runCandidateGates({
    worktree: '/tmp/candidate',
    primary: '/actual/primary/subdir',
    branch: 'candidate',
    base: 'main',
    allowExact: [],
    allowPrefixes: [],
    gates: ['test'],
    runner,
    realpath: async (value) => value,
  });
  expect(report.classification).toBe('contract-failed');
  expect(report.checks.registeredPrimaryWorktree).toBe(false);
  expect(calls).toHaveLength(1);
});

it('continues through a timed-out or failed gate and classifies the complete report', async () => {
  const { runner } = fakeRunner((invocation) => {
    if (invocation.command === 'git') {
      const key = invocation.args.join(' ');
      if (key === 'worktree list --porcelain') {
        return successful(
          'worktree /tmp/primary\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main\n\n' +
            'worktree /tmp/candidate\nHEAD 2222222222222222222222222222222222222222\nbranch refs/heads/candidate\n',
        );
      }
      if (key === 'branch --show-current') return successful('candidate\n');
      if (key === 'rev-parse --verify main^{commit}') return successful('1111111111111111111111111111111111111111\n');
      if (key === 'merge-base HEAD main') return successful('1111111111111111111111111111111111111111\n');
      return successful('');
    }
    return invocation.args.includes('test')
      ? { exitCode: null, stdout: 'partial', stderr: 'slow', timedOut: true }
      : { exitCode: 7, stdout: 'failed', stderr: 'bad', timedOut: false };
  });

  const report = await runCandidateGates({
    worktree: '/tmp/candidate',
    primary: '/tmp/primary',
    branch: 'candidate',
    base: 'main',
    allowExact: [],
    allowPrefixes: ['scripts/'],
    gates: ['test', 'script-typecheck'],
    runner,
    realpath: async (value) => value,
  });

  expect(report.ok).toBe(false);
  expect(report.classification).toBe('gate-failed');
  expect(report.gates).toHaveLength(2);
  expect(report.gates[0]?.status).toBe('timeout');
  expect(report.gates[1]?.status).toBe('failed');
  expect(report.gates[0]?.stdout).toBe('partial');
});

it('default runner enforces a deadline and carries output truncation metadata', async () => {
  const result = await createDefaultRunner()({
    command: process.execPath,
    args: ['-e', 'setInterval(() => process.stdout.write("x".repeat(20)), 1);'],
    cwd: '/tmp',
    env: {},
    timeoutMs: 100,
    maxOutputBytes: 10,
  });
  expect(result.timedOut).toBe(true);
  expect(result.stdoutTruncated).toBe(true);
  expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(10);
});

it('preserves split multibyte stdout chunks with valid UTF-8', async () => {
  const result = await createDefaultRunner()({
    command: process.execPath,
    args: [
      '-e',
      'process.stdout.write(Buffer.from([0xf0, 0x9f])); setTimeout(() => process.stdout.write(Buffer.from([0x98, 0x80])), 10);',
    ],
    cwd: '/tmp',
    env: {},
    timeoutMs: 1_000,
    maxOutputBytes: 10,
  });
  expect(result.timedOut).toBe(false);
  expect(result.stdout).toBe('😀');
  expect(Buffer.from(result.stdout, 'utf8').toString('utf8')).toBe(result.stdout);
});

it('emits machine-readable JSON and the matching exit classification for CLI argv errors', async () => {
  let output = '';
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  const exitCode = await main(['--worktree', 'relative']);
  write.mockRestore();
  expect(exitCode).toBe(EXIT_CODES['invalid-input']);
  expect(JSON.parse(output)).toEqual({ ok: false, classification: 'invalid-input', errors: ['--primary is required'] });
});

it('uses stable exit classifications', () => {
  expect(EXIT_CODES).toEqual({
    pass: 0,
    'gate-failed': 1,
    'scope-failed': 2,
    'contract-failed': 3,
    'invalid-input': 4,
  });
});
