import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPromptSpec } from './prompt-constructor.js';
import { resolveProfile } from '../services/profiles/index.js';
import { getAgentDefinition } from '../agent.js';
import { createMockSettingsService } from '../services/settings/settings-service.mock.js';
import { ExecutionContext } from '../services/execution-context.js';
import { BackgroundShellRegistry } from '../services/shell/background-shell-registry.js';
import { BackgroundShellOutputStore } from '../services/shell/background-shell-output-store.js';
import { BackgroundShellWatches } from '../services/shell/background-shell-watches.js';
import { SessionBrowser } from '../services/conversation/session-browser.js';
import { RUN_CODE_PROHIBITED_TOOLS } from '../tools/system/run-code/run-code.js';
import { getBackgroundShellAddendum } from './background-shell.js';
import { getSubagentDelegationAddendum } from './subagent-delegation.js';
import { getDirectEditorToolsAddendum, getScriptPrimaryToolsAddendum } from './tool-surface-guidance.js';

it('guides run_code exact searches and syntax-sensitive data', () => {
  const guidance = getScriptPrimaryToolsAddendum('editors');

  expect(guidance).toContain('fixed_strings: true');
  expect(guidance).toContain('pattern` is a regular expression');
  expect(guidance).toContain('pass it through the `run_code` `inputs` parameter');
  expect(guidance).toContain(
    '- For multiline edit text or data containing quotes, backticks, or `${...}`, pass it through the `run_code` `inputs` parameter instead of embedding it in JavaScript source.',
  );
});

it('names only editors on the active run_code editing surface and identifies shell as direct-only', () => {
  const patchSurface = buildPromptSpec({
    model: 'gpt-5.6',
    profile: profile('builtin:standard'),
    runCodeEnabled: true,
    editorSurface: 'patch',
  }).inlineSections.join('\n');
  const otherSurface = buildPromptSpec({
    model: 'claude-3.7-sonnet',
    profile: profile('builtin:standard'),
    runCodeEnabled: true,
    editorSurface: 'editors',
  }).inlineSections.join('\n');
  const noWriteSurface = buildPromptSpec({
    model: 'claude-3.7-sonnet',
    profile: profile('builtin:standard'),
    runCodeEnabled: true,
    editorSurface: 'none',
  }).inlineSections.join('\n');

  expect(patchSurface).toContain('`tools.apply_patch`');
  expect(patchSurface).not.toContain('`tools.create_file`');
  expect(patchSurface).not.toContain('`tools.search_replace`');
  expect(patchSurface).toContain('create new files with a `*** Add File:` patch');
  expect(otherSurface).toContain('`tools.create_file`');
  expect(otherSurface).toContain('`tools.search_replace`');
  expect(otherSurface).not.toContain('`tools.apply_patch`');
  expect(noWriteSurface).not.toContain('`tools.apply_patch`');
  expect(noWriteSurface).not.toContain('`tools.create_file`');
  expect(noWriteSurface).not.toContain('`tools.search_replace`');
  for (const surface of [patchSurface, otherSurface, noWriteSurface]) {
    expect(surface).toContain('`tools.shell` does not exist inside `run_code`');
  }
  expect(patchSurface).toContain('Do not write files with');
  expect(otherSurface).toContain('Do not write files with');
  expect(patchSurface).toContain('heredocs, Python, or other shell tricks');
  expect(otherSurface).toContain('heredocs, Python, or other shell tricks');
  for (const surface of [patchSurface, otherSurface, noWriteSurface]) {
    expect(surface).toContain('Do not use Python to read files when `tools.read_file` is available');
  }
  expect(noWriteSurface).not.toContain('Do not write files with');
  expect(noWriteSurface).toContain('## File, search, and web tools');
  expect(noWriteSurface).toContain('tools.grep({ pattern, fixed_strings: true })');
  expect(noWriteSurface).not.toContain('\\n\\n');
  expect(patchSurface).toContain('`shell` is a direct tool');
  expect(patchSurface).toContain('File, search, web, and edit tools are not on your direct tool list.');
  expect(otherSurface).toContain('File, search, web, and edit tools are not on your direct tool list.');
  expect(noWriteSurface).toContain('File, search, and web tools are not on your direct tool list.');
  expect(patchSurface).toContain('`tools.shell` does not exist inside `run_code`');
});

const fullCapabilityLogging = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  security: () => {},
  setCorrelationId: () => {},
  clearCorrelationId: () => {},
  getCorrelationId: () => undefined,
} as any;

function fullCapabilityTools() {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'agent.smartModel': 'gpt-4o',
    'app.searchViaShell': 'off',
    enable_agent_workflow: true,
    'sandbox.enabled': true,
  });
  const executionContext = new ExecutionContext();
  const backgroundShellRegistry = new BackgroundShellRegistry();
  const store = new BackgroundShellOutputStore();
  const backgroundShellOutput = {
    store,
    watches: new BackgroundShellWatches({ store, scheduler: { schedule: () => 0, cancel: () => {} } }),
  };
  const skillsService = {
    getAvailableSkillsForModel: () => [{ name: 'measurement', location: '/tmp/measurement', body: '' }],
    getSkillCatalog: () => '',
  } as any;
  const sessionBrowser = new SessionBrowser(() => ({ projectPath: process.cwd() }));
  const status = {
    runId: 'measurement',
    role: 'worker',
    status: 'completed',
    task: 'measurement',
    taskPreview: 'measurement',
    startedAt: 0,
    elapsedMs: 0,
    toolCounts: {},
  } as any;
  return getAgentDefinition(
    {
      settingsService,
      loggingService: fullCapabilityLogging,
      executionContext,
      askMentor: async () => 'mentor',
      runSubagent: async () => ({ finalText: 'subagent' }),
      runSubagentAsync: async () => ({ runId: 'measurement', role: 'worker', status: 'running', task: 'measurement' }),
      getSubagentResult: async () => ({
        agentId: 'measurement',
        role: 'worker',
        status: 'completed',
        finalText: 'subagent',
        filesChanged: [],
        toolsUsed: [],
      }),
      getSubagentStatus: () => status,
      sendSubagentMessage: () => ({ ok: true, runId: 'measurement', status: 'running', delivery: 'queued' }),
      cancelSubagentRun: () => ({ ok: true, runId: 'measurement', status: 'cancelling' }),
      getAskUserAnswer: () => 'answer',
      skillsService,
      agentRuntime: { agent: () => ({} as any) },
      backgroundShellRegistry: backgroundShellRegistry as any,
      backgroundShellOutput,
      sessionBrowser,
      requestSessionRollover: () => ({} as any),
      configureTaskCheckIn: () => ({} as any),
      setTaskCheckInPolicy: () => {},
    },
    'gpt-4o',
  ).tools;
}

const profile = (id: string) => resolveProfile(id);

it('buildPromptSpec selects the profile identity and model-family base prompt', () => {
  expect(buildPromptSpec({ model: 'gpt-5.5', profile: profile('builtin:lite') }).basePromptContent).toBeTruthy();
  expect(buildPromptSpec({ model: 'claude-3-sonnet', profile: profile('builtin:standard') }).basePromptFile).toBe(
    'anthropic.md',
  );
  expect(buildPromptSpec({ model: 'gpt-4o', profile: profile('builtin:standard') }).basePromptFile).toBe(
    'simple_v4.md',
  );
});

it('buildPromptSpec keeps all non-lite built-in profiles prompt-spec equivalent', () => {
  const specs = ['standard', 'plan', 'mentor', 'orchestrator'].map((id) =>
    buildPromptSpec({ model: 'gpt-5.6', profile: profile(`builtin:${id}`) }),
  );
  expect(specs[1]).toEqual(specs[0]);
  expect(specs[2]).toEqual(specs[0]);
  expect(specs[3]).toEqual(specs[0]);
  expect(buildPromptSpec({ model: 'gpt-5.6', profile: profile('builtin:lite') })).not.toEqual(specs[0]);
});

it('buildPromptSpec composes file fragments in stable order', () => {
  const spec = buildPromptSpec({
    model: 'gpt-5.4-mini',
    profile: profile('builtin:standard'),
    searchViaShell: true,
  });

  expect(spec.fragmentFiles).toEqual([
    'approval-model.md',
    'worktree-hygiene.md',
    'plan-mode-stub.md',
    'pair-mode-stub.md',
    'mentor-mode-stub.md',
    'orchestrator-mode-stub.md',
  ]);

  expect(spec.inlineSections).toContainEqual(expect.stringContaining('## Shell Sandbox'));
});

it('does not teach loaded run_code instruction surfaces to call script-only tools directly', () => {
  const tools = fullCapabilityTools();
  const scriptOnly = tools.filter((tool) => !RUN_CODE_PROHIBITED_TOOLS.has(tool.name)).map((tool) => tool.name);
  const surfaces = ['lite.md', 'session-browser.md', 'orchestrator.md', 'gpt.md'].map((file) =>
    readFileSync(join(import.meta.dirname, file), 'utf8'),
  );
  surfaces.push(
    getScriptPrimaryToolsAddendum('editors'),
    getBackgroundShellAddendum(),
    getSubagentDelegationAddendum({ backgroundEnabled: true, controlsEnabled: true, foregroundEnabled: false }),
  );

  const directReferences = scriptOnly.flatMap((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // This preceding-dot exclusion is load-bearing: tools.<name> is the valid
    // script reference form and must not count as a bare direct-tool reference.
    const pattern = new RegExp(`(?<![A-Za-z0-9_.])${escaped}(?![A-Za-z0-9_])`);
    return surfaces.some((surface) => pattern.test(surface)) ? [name] : [];
  });

  expect(directReferences).toEqual([]);
});

it('selects script-primary vs direct-editor guidance from runCodeEnabled', () => {
  const enabled = buildPromptSpec({
    model: 'gpt-5.6',
    profile: profile('builtin:standard'),
    runCodeEnabled: true,
    editorSurface: 'patch',
  });
  const disabled = buildPromptSpec({
    model: 'gpt-5.6',
    profile: profile('builtin:standard'),
    runCodeEnabled: false,
  });
  expect(enabled.inlineSections.join('\n')).toContain(getScriptPrimaryToolsAddendum('patch'));
  expect(enabled.inlineSections.join('\n')).not.toContain(getDirectEditorToolsAddendum());
  expect(disabled.inlineSections.join('\n')).toContain(getDirectEditorToolsAddendum());
  expect(disabled.inlineSections.join('\n')).not.toContain(getScriptPrimaryToolsAddendum('patch'));
});

it('buildPromptSpec ships the approval mechanism to every non-lite profile', () => {
  for (const model of ['gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4', 'gpt-4o', 'claude-opus-4', 'kimi-k2']) {
    const spec = buildPromptSpec({ model, profile: profile('builtin:standard') });
    expect(spec.fragmentFiles).toContain('approval-model.md');
  }

  const orchestrator = buildPromptSpec({ model: 'gpt-5.6-sol', profile: profile('builtin:orchestrator') });
  expect(orchestrator.fragmentFiles).toContain('approval-model.md');

  const lite = buildPromptSpec({ model: 'gpt-5.6-sol', profile: profile('builtin:lite') });
  expect(lite.fragmentFiles).not.toContain('approval-model.md');
});

it('buildPromptSpec attaches the Plan Mode stub in standard and plan mode so the instruction prefix stays cache-stable', () => {
  const standard = buildPromptSpec({ model: 'gpt-4o', profile: profile('builtin:standard') });
  expect(standard.fragmentFiles.includes('plan-mode-stub.md')).toBe(true);
  expect(standard.fragmentFiles.includes('plan-mode-info.md')).toBe(false);

  const plan = buildPromptSpec({ model: 'gpt-4o', profile: profile('builtin:plan') });
  expect(plan.fragmentFiles.includes('plan-mode-stub.md')).toBe(true);
  expect(plan.fragmentFiles.includes('plan-mode-info.md')).toBe(false);
  expect(plan.fragmentFiles).toEqual(standard.fragmentFiles);
});

it('buildPromptSpec keeps all non-lite mode stubs stable while lite stays minimal', () => {
  const lite = buildPromptSpec({ model: 'gpt-5.5', profile: profile('builtin:lite') });
  expect(lite.fragmentFiles.includes('plan-mode-info.md')).toBe(false);
  expect(lite.fragmentFiles.includes('plan-mode-stub.md')).toBe(false);
  expect(lite.fragmentFiles.includes('mentor-mode-stub.md')).toBe(false);
  expect(lite.fragmentFiles.includes('orchestrator-mode-stub.md')).toBe(false);

  const orchestrator = buildPromptSpec({ model: 'gpt-5.5', profile: profile('builtin:orchestrator') });
  expect(orchestrator.fragmentFiles.includes('plan-mode-info.md')).toBe(false);
  expect(orchestrator.fragmentFiles.includes('plan-mode-stub.md')).toBe(true);
  expect(orchestrator.fragmentFiles.includes('mentor-mode-stub.md')).toBe(true);
  expect(orchestrator.fragmentFiles.includes('orchestrator-mode-stub.md')).toBe(true);
});

it('buildPromptSpec keeps the non-lite instruction prefix identical across modes', () => {
  const standard = buildPromptSpec({ model: 'gpt-4o', profile: profile('builtin:standard') });
  const plan = buildPromptSpec({ model: 'gpt-4o', profile: profile('builtin:plan') });
  const mentor = buildPromptSpec({ model: 'gpt-4o', profile: profile('builtin:mentor') });
  const orchestrator = buildPromptSpec({ model: 'gpt-4o', profile: profile('builtin:orchestrator') });

  expect(plan).toEqual(standard);
  expect(mentor).toEqual(standard);
  expect(orchestrator).toEqual(standard);
});

it('buildPromptSpec includes subagent delegation for orchestrator mode', () => {
  const orchestrator = buildPromptSpec({
    model: 'gpt-5.5',
    profile: profile('builtin:orchestrator'),
    runSubagentEnabled: true,
    codeContextEnabled: true,
    searchViaShell: false,
  });
  expect(orchestrator.inlineSections.some((s) => s.includes('Delegating to subagents'))).toBe(true);
  expect(orchestrator.inlineSections.some((s) => s.includes('Delegate when it provides meaningful leverage'))).toBe(
    true,
  );
  expect(orchestrator.inlineSections.some((s) => s.includes('Delegate workspace inspection'))).toBe(false);
  expect(orchestrator.inlineSections.some((s) => s.includes('Code Context'))).toBe(false);
});

it('buildPromptSpec uses lite base and skips worktree-hygiene fragment in lite mode', () => {
  const lite = buildPromptSpec({
    model: 'gpt-5.5',
    profile: profile('builtin:lite'),
    codeContextEnabled: true,
    searchViaShell: false,
  });
  expect(lite.basePromptFile).toBeUndefined();
  expect(lite.basePromptContent).toBeTruthy();
  expect(lite.fragmentFiles.includes('worktree-hygiene.md')).toBe(false);
  // Shell sandbox plus tool-surface routing are added inline in lite mode.
  expect(lite.inlineSections.length).toBe(2);
  expect(lite.inlineSections[0]).toContain('## Shell Sandbox');
  expect(lite.inlineSections[1]).toContain('## File, search, and edit tools');
});

it('buildPromptSpec excludes shell-sandbox when sandbox is disabled', () => {
  const spec = buildPromptSpec({
    model: 'gpt-4o',
    profile: profile('builtin:standard'),
    sandboxEnabled: false,
  });
  expect(spec.inlineSections.some((s) => s.includes('## Shell Sandbox'))).toBe(false);
  expect(spec.fragmentFiles.includes('worktree-hygiene.md')).toBe(true);
});

it('buildPromptSpec tells the model to wait for background shell completion instead of polling', () => {
  const spec = buildPromptSpec({
    model: 'gpt-4o',
    profile: profile('builtin:standard'),
    backgroundShellEnabled: true,
  });
  const guidance = spec.inlineSections.join('\n');

  expect(guidance).toContain('Background shell jobs');
  expect(guidance).toContain('`background: true`');
  expect(guidance).toContain('do NOT call `tools.get_shell_job(...)` as a polling loop');
  expect(guidance.toLowerCase()).toContain('end the current turn and wait for the automatic completion notification');
  expect(guidance.toLowerCase()).toContain('do not run `sleep` merely to wait');
});

it('includes one memory guidance section and gates the pinned context by regular memory mode', () => {
  const args = {
    model: 'gpt-4o',
    profile: profile('builtin:standard'),
    memoryGuidance: 'Memory guidance',
    memoryContext: 'Global-only index',
  };
  const enabled = buildPromptSpec({ ...args, memoryEnabled: true });
  expect(enabled.inlineSections.filter((section) => section === 'Memory guidance')).toHaveLength(1);
  expect(enabled.inlineSections).toContain('Global-only index');
  expect(buildPromptSpec({ ...args, memoryEnabled: false }).inlineSections).not.toContain('Global-only index');
  expect(
    buildPromptSpec({ ...args, profile: profile('builtin:lite'), memoryEnabled: true }).inlineSections,
  ).not.toContain('Global-only index');
});

it('buildPromptSpec includes unified background delegation guidance when background execution is enabled', () => {
  const spec = buildPromptSpec({
    model: 'gpt-4o',
    profile: profile('builtin:standard'),
    runSubagentEnabled: true,
    runSubagentAsyncEnabled: true,
  });
  expect(spec.inlineSections.some((s) => s.includes('execution: "background"'))).toBe(true);
  expect(spec.inlineSections.some((s) => s.includes('run_subagent_async'))).toBe(false);
  expect(spec.inlineSections.some((s) => s.includes('get_subagent_result'))).toBe(true);
  expect(spec.inlineSections.some((s) => s.includes('explorer'))).toBe(true);
  expect(spec.inlineSections.some((s) => s.includes('worker'))).toBe(true);
  expect(spec.inlineSections.some((s) => s.includes('mentor'))).toBe(true);
});

it('buildPromptSpec tells orchestrators to trust successful delegation and wait without duplicating it', () => {
  const spec = buildPromptSpec({
    model: 'gpt-4o',
    profile: profile('builtin:orchestrator'),
    runSubagentEnabled: true,
    runSubagentAsyncEnabled: true,
  });
  const guidance = spec.inlineSections.join('\n');

  expect(guidance).toContain('`execution: "background"`');
  expect(guidance).toContain('A returned handle with `status: "running"` means delegation succeeded');
  expect(guidance).toContain('Do not duplicate or independently perform the delegated unit');
  expect(guidance.toLowerCase()).toContain('end the current turn and wait for the completion notification');
  expect(guidance).toContain('inlines the full result so you can continue directly');
  expect(guidance).toContain('do NOT call `tools.get_subagent_result(...)` immediately');
  expect(guidance).toContain('Active runs are refused rather than awaited');
  expect(guidance).not.toContain('Use `run_subagent` only');
});

it('buildPromptSpec excludes async subagent guidance in lite mode', () => {
  const spec = buildPromptSpec({
    model: 'gpt-4o',
    profile: profile('builtin:lite'),
    runSubagentAsyncEnabled: true,
  });
  expect(spec.inlineSections.some((s) => s.includes('Asynchronous subagents'))).toBe(false);
});

it('buildPromptSpec excludes async subagent guidance when disabled', () => {
  const spec = buildPromptSpec({
    model: 'gpt-4o',
    profile: profile('builtin:standard'),
    runSubagentAsyncEnabled: false,
  });
  expect(spec.inlineSections.some((s) => s.includes('Asynchronous subagents'))).toBe(false);
});

it('background shell addendum teaches explicit finite timeouts for long-lived work', () => {
  const spec = buildPromptSpec({
    model: 'gpt-4o',
    profile: profile('builtin:standard'),
    backgroundShellEnabled: true,
  });
  const guidance = spec.inlineSections.join('\n');

  expect(guidance).toContain('must pass an explicit finite `timeout_ms`');
  expect(guidance).toContain('two hours for a watcher');
  expect(guidance).toContain('15 minutes for a full-suite gate');
  expect(guidance).toContain('never detach a job with nohup to escape the registry');
  expect(guidance).toContain('Attach `monitor` in the same launch call');
});
