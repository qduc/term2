import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';
import {
  SubagentToolFactory,
  SubagentToolPolicy,
  captureValidationIfMatch,
  isValidationCommand,
  type ValidationCapture,
} from './tool-policy.js';
import { buildInstructions } from './role-loader.js';
import type { SubagentDefinition } from './types.js';
import {
  createMockLogger,
  createMockSettings,
  createSessionContextService,
} from './test-helpers/subagent-manager-fixtures.js';

function createDefinition(overrides: Partial<SubagentDefinition>): SubagentDefinition {
  return {
    role: 'workflow-agent',
    name: 'workflow-agent',
    instructions: '',
    canRead: false,
    canWrite: true,
    canSearchWeb: false,
    canRunShell: false,
    maxTurns: 1,
    model: 'gpt-5',
    provider: 'test',
    reasoningEffort: 'default',
    ...overrides,
  };
}

function createMemorySettings(enabled = true) {
  return createMockSettings({
    memory: {
      enabled,
      directory: '/tmp/subagent-memory',
      contextBudgetChars: 1000,
      searchDefaultLimit: 10,
      searchMaxLimit: 20,
    },
  });
}

function buildToolNames(
  definition: SubagentDefinition,
  memoryEnabled = true,
  askOrchestrator?: (question: string) => Promise<string>,
): string[] {
  const settings = createMemorySettings(memoryEnabled);
  const policy = new SubagentToolPolicy({
    settings,
    logger: createMockLogger(),
    sessionContextService: createSessionContextService(),
  });
  return new SubagentToolFactory({ settings, logger: createMockLogger(), toolPolicy: policy })
    .buildToolDefinitions(definition, [], '', false, false, undefined, undefined, askOrchestrator)
    .map((tool) => tool.name);
}

describe('SubagentToolFactory editor capability selection', () => {
  it('maps an explicitly requested editor to the model-compatible editor interface', () => {
    for (const requestedEditor of ['apply_patch', 'search_replace', 'create_file']) {
      expect(buildToolNames(createDefinition({ tools: [requestedEditor] }))).toEqual(['apply_patch']);
      expect(buildToolNames(createDefinition({ model: 'other-model', tools: [requestedEditor] }))).toEqual([
        'search_replace',
        'create_file',
      ]);
    }
  });

  it('does not grant editor tools from an explicit request, shell, or read authority', () => {
    expect(
      buildToolNames(
        createDefinition({
          canRead: true,
          canWrite: false,
          canRunShell: true,
          tools: ['read_file', 'shell', 'create_file'],
        }),
      ),
    ).toEqual(['read_file', 'shell']);
  });
});

describe('SubagentToolFactory search tool descriptions', () => {
  function buildTools(definition: SubagentDefinition, searchViaShell: boolean) {
    const settings = createMemorySettings();
    const policy = new SubagentToolPolicy({
      settings,
      logger: createMockLogger(),
      sessionContextService: createSessionContextService(),
    });
    return new SubagentToolFactory({ settings, logger: createMockLogger(), toolPolicy: policy }).buildToolDefinitions(
      definition,
      [],
      '',
      searchViaShell,
      false,
    );
  }

  it('references shell for file listing when glob is not registered (searchViaShell)', () => {
    const definition = createDefinition({ role: 'explorer', canRead: true, canRunShell: true, model: 'gpt-4o' });
    const tools = buildTools(definition, true);
    const toolNames = tools.map((tool) => tool.name);

    // When searchViaShell is enabled, grep/glob are omitted and shell handles search.
    expect(toolNames).not.toContain('grep');
    expect(toolNames).not.toContain('glob');
    expect(toolNames).toContain('shell');

    const codeContextTool = tools.find((tool) => tool.name === 'code_context_search');
    expect(codeContextTool?.description).toContain('use shell');
    expect(codeContextTool?.description).not.toContain('use glob');
  });

  it('references glob for file listing when glob is registered', () => {
    const definition = createDefinition({ role: 'explorer', canRead: true, canRunShell: false, model: 'gpt-4o' });
    const tools = buildTools(definition, false);
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toContain('grep');
    expect(toolNames).toContain('glob');

    const grepTool = tools.find((tool) => tool.name === 'grep');
    const codeContextTool = tools.find((tool) => tool.name === 'code_context_search');
    expect(grepTool?.description).toContain('use glob');
    expect(grepTool?.description).not.toContain('use shell');
    expect(codeContextTool?.description).toContain('use glob');
    expect(codeContextTool?.description).not.toContain('use shell');
  });
});

describe('SubagentToolFactory memory authority', () => {
  it.each(['explorer', 'worker', 'researcher', 'librarian'] as const)(
    'provisions ask_orchestrator only for an eligible async %s segment',
    (role) => {
      expect(buildToolNames(createDefinition({ role }), true, async () => 'answer')).toContain('ask_orchestrator');
      expect(buildToolNames(createDefinition({ role }))).not.toContain('ask_orchestrator');
    },
  );

  it('never provisions ask_orchestrator for mentor segments', () => {
    expect(buildToolNames(createDefinition({ role: 'mentor' }), true, async () => 'answer')).not.toContain(
      'ask_orchestrator',
    );
  });

  it.each(['explorer', 'worker', 'researcher'] as const)('gives %s read-only memory tools', (role) => {
    const tools = buildToolNames(createDefinition({ role }));

    expect(tools.filter((name) => name.startsWith('memory_'))).toEqual([
      'memory_list',
      'memory_get',
      'memory_search',
      'memory_retrieve',
    ]);
  });

  it('keeps mentor tool-free even when memory is enabled', () => {
    expect(
      buildToolNames(
        createDefinition({
          role: 'mentor',
          canRead: false,
          canWrite: false,
        }),
      ),
    ).toEqual([]);
  });

  it('omits memory tools for disabled subagent memory', () => {
    expect(
      buildToolNames(createDefinition({ role: 'worker' }), false).filter((name) => name.startsWith('memory_')),
    ).toEqual([]);
  });

  it('gives librarian all memory tools (write access)', () => {
    const tools = buildToolNames(createDefinition({ role: 'librarian' }));

    expect(tools.filter((name) => name.startsWith('memory_'))).toEqual([
      'memory_list',
      'memory_get',
      'memory_search',
      'memory_retrieve',
      'memory_create',
      'memory_update',
      'memory_delete',
    ]);
  });

  it('gives librarian memory-specific guidance without automatic context injection', () => {
    const definition = createDefinition({ role: 'librarian', canRead: false, canWrite: false });
    const settings = createMemorySettings();
    const instructions = buildInstructions(definition, [], false, settings);

    expect(instructions).toContain('memory librarian');
    expect(instructions).toContain('reviewable proposal');
    expect(instructions).not.toContain('The following memories are summaries from previous sessions');
  });

  it('keeps read-only memory guidance and proposal protocol without automatic context injection', () => {
    const definition = createDefinition({ role: 'explorer', canRead: true, canWrite: false });
    const settings = createMemorySettings();
    const instructions = buildInstructions(definition, [], false, settings);

    expect(instructions).toContain('materially improve correctness');
    expect(instructions).toContain('propose it in your final report');
    expect(instructions).not.toContain('The following memories are summaries from previous sessions');
  });

  it.each([
    ['mentor', createDefinition({ role: 'mentor', canRead: false, canWrite: false }), true],
    ['disabled worker', createDefinition({ role: 'worker', canRead: true, canWrite: false }), false],
  ])('omits memory tools, guidance, and context for %s', (_name, definition, memoryEnabled) => {
    const settings = createMemorySettings(memoryEnabled);
    const instructions = buildInstructions(definition, [], false, settings);

    expect(buildToolNames(definition, memoryEnabled).filter((name) => name.startsWith('memory_'))).toEqual([]);
    expect(instructions).not.toContain('Persistent memory');
    expect(instructions).not.toContain('The following memories are summaries from previous sessions');
  });
});

describe('SubagentToolFactory agent tool wrapping', () => {
  function buildFailingTool(callbacks: {
    onToolStart: (name: string) => void;
    onToolComplete: (name: string) => void;
  }) {
    const settings = createMemorySettings();
    const policy = new SubagentToolPolicy({
      settings,
      logger: createMockLogger(),
      sessionContextService: createSessionContextService(),
    });
    return new SubagentToolFactory({ settings, logger: createMockLogger(), toolPolicy: policy }).buildAgentTools(
      [
        {
          name: 'exploding_tool',
          description: 'Always throws.',
          parameters: z.object({}),
          needsApproval: () => false,
          execute: async () => {
            throw new Error('tool exploded');
          },
          formatCommandMessage: () => [],
        },
      ],
      { providerId: 'test', ...callbacks },
    )[0] as any;
  }

  // The completion callback closes the active-tool gate that defers a steering
  // interrupt; if a throwing tool skipped it, the gate would never reopen.
  it('reports tool completion even when the tool throws', async () => {
    const onToolStart = vi.fn();
    const onToolComplete = vi.fn();
    const tool = buildFailingTool({ onToolStart, onToolComplete });

    await tool.invoke({}, '{}', {}).catch(() => undefined);

    expect(onToolStart).toHaveBeenCalledOnce();
    expect(onToolComplete).toHaveBeenCalledOnce();
  });
});

describe('shell-edit-hole measurement (plan D2)', () => {
  // Documents the coverage gap of extractPathsFromCommand: it only captures
  // redirection (>/>>/tee), so most shell-edit commands are invisible to
  // filesChanged and therefore to diffStat. This drives the decision to defer
  // git reconciliation: the prompt steers workers toward write tools, and
  // worktree isolation makes git accurate as a cross-check.
  const policy = new SubagentToolPolicy({
    settings: createMockSettings(),
    logger: createMockLogger(),
    sessionContextService: createSessionContextService(),
  });
  const cwd = process.cwd();

  it('captures redirection targets (echo > file, tee)', () => {
    expect(policy.extractPathsFromCommand('echo hello > out.txt', cwd)).toHaveLength(1);
    expect(policy.extractPathsFromCommand('echo hello >> out.txt', cwd)).toHaveLength(1);
    expect(policy.extractPathsFromCommand('echo hello | tee out.txt', cwd)).toHaveLength(1);
  });

  it('does NOT capture sed -i, mv, rm, touch, cp (the shell-edit hole)', () => {
    expect(policy.extractPathsFromCommand("sed -i 's/old/new/' file.ts", cwd)).toHaveLength(0);
    expect(policy.extractPathsFromCommand('mv old.ts new.ts', cwd)).toHaveLength(0);
    expect(policy.extractPathsFromCommand('rm file.ts', cwd)).toHaveLength(0);
    expect(policy.extractPathsFromCommand('touch new.ts', cwd)).toHaveLength(0);
    expect(policy.extractPathsFromCommand('cp src.ts dst.ts', cwd)).toHaveLength(0);
  });

  it('does NOT capture npm/pnpm/vitest/tsc (validation commands — expected, they are not writes)', () => {
    expect(policy.extractPathsFromCommand('pnpm test', cwd)).toHaveLength(0);
    expect(policy.extractPathsFromCommand('npx vitest run', cwd)).toHaveLength(0);
    expect(policy.extractPathsFromCommand('tsc --noEmit', cwd)).toHaveLength(0);
  });
});

describe('validation capture (plan D4)', () => {
  it('isValidationCommand detects test/lint/typecheck/tsc/eslint/build commands', () => {
    expect(isValidationCommand('pnpm vitest run')).toBe(true);
    expect(isValidationCommand('pnpm test')).toBe(true);
    expect(isValidationCommand('npm test')).toBe(true);
    expect(isValidationCommand('npx tsc --noEmit')).toBe(true);
    expect(isValidationCommand('npx eslint .')).toBe(true);
    expect(isValidationCommand('npm run build')).toBe(true);
    expect(isValidationCommand('pnpm typecheck')).toBe(true);
    expect(isValidationCommand('yarn lint')).toBe(true);
    expect(isValidationCommand('vitest run')).toBe(true);
    expect(isValidationCommand('jest')).toBe(true);
  });

  it('isValidationCommand does NOT match ordinary read/write commands', () => {
    expect(isValidationCommand('ls -la')).toBe(false);
    expect(isValidationCommand('cat file.ts')).toBe(false);
    expect(isValidationCommand('echo hello > out.txt')).toBe(false);
    expect(isValidationCommand('sed -i "s/a/b/" file.ts')).toBe(false);
    expect(isValidationCommand('git status')).toBe(false);
    expect(isValidationCommand('')).toBe(false);
  });

  it('captureValidationIfMatch records command, exit status from "Exit: N", and excerpt', () => {
    const capture: ValidationCapture = {};
    captureValidationIfMatch(capture, 'pnpm vitest run', 'Tests passed\nExit: 0');
    expect(capture.value).toBeDefined();
    expect(capture.value!.command).toBe('pnpm vitest run');
    expect(capture.value!.exitStatus).toBe(0);
    expect(capture.value!.outputExcerpt).toContain('Tests passed');
  });

  it('captures non-zero exit status from "exit code: N" format', () => {
    const capture: ValidationCapture = {};
    captureValidationIfMatch(capture, 'npm test', 'FAIL\nexit code: 1');
    expect(capture.value!.exitStatus).toBe(1);
  });

  it('does NOT overwrite prior validation with a non-validation command', () => {
    const capture: ValidationCapture = {};
    captureValidationIfMatch(capture, 'pnpm test', 'ok\nExit: 0');
    const first = capture.value;
    captureValidationIfMatch(capture, 'ls -la', 'done');
    expect(capture.value).toBe(first); // unchanged
  });

  it('defaults exit status to 0 when no exit marker is found (success output)', () => {
    const capture: ValidationCapture = {};
    captureValidationIfMatch(capture, 'pnpm test', 'all tests passed, nice!');
    expect(capture.value!.exitStatus).toBe(0);
  });

  it('truncates output excerpt to 2k chars', () => {
    const capture: ValidationCapture = {};
    const longOutput = 'x'.repeat(3000);
    captureValidationIfMatch(capture, 'pnpm test', longOutput);
    expect(capture.value!.outputExcerpt.length).toBeLessThanOrEqual(2000);
    expect(capture.value!.outputExcerpt).toContain('truncated');
  });

  it('captureValidationIfMatch is a no-op when capture is undefined', () => {
    expect(() => captureValidationIfMatch(undefined, 'pnpm test', 'ok')).not.toThrow();
  });
});

describe('diffStat capture (plan D3)', () => {
  const policy = new SubagentToolPolicy({
    settings: createMockSettings(),
    logger: createMockLogger(),
    sessionContextService: createSessionContextService(),
  });
  const cwd = process.cwd();

  function makeWriteTool(result: string): any {
    return {
      name: 'create_file',
      description: 'create',
      parameters: { safeParse: () => ({ success: true, data: {} }) },
      needsApproval: () => false,
      execute: async () => result,
      formatCommandMessage: () => [],
    };
  }

  it('records a line delta for a new file via create_file', async () => {
    const diffDeltas = new Map<string, { added: number; deleted: number }>();
    const filesChanged: string[] = [];
    // Use a tmp path that doesn't exist yet.
    const tmpPath = 'tmp-test-diffstat-new.ts';
    const fullPath = path.resolve(cwd, tmpPath);
    try {
      // Ensure it doesn't exist
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);

      // Simulate the write by writing the file before the delta computation.
      // The write tool's execute returns the result; then wrapWriteTool
      // computes the delta. We write the file in the mock execute.
      const mockTool = {
        ...makeWriteTool(`Created ${tmpPath}`),
        execute: async () => {
          fs.writeFileSync(fullPath, 'line1\nline2\nline3\n');
          return `Created ${tmpPath}`;
        },
      };
      const wrapped2 = policy.wrapWriteTool(
        mockTool,
        cwd,
        filesChanged,
        (params: any) => [params?.path ?? tmpPath],
        false,
        diffDeltas,
      );
      await wrapped2.execute({ path: tmpPath });
      expect(filesChanged).toContain(tmpPath);
      const delta = diffDeltas.get(fullPath);
      expect(delta).toBeDefined();
      // 'line1\nline2\nline3\n' splits to ['line1','line2','line3',''] = 4 elements
      expect(delta!.added).toBe(4);
      expect(delta!.deleted).toBe(0);
    } finally {
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    }
  });
});
