import { it, expect } from 'vitest';
import { buildPromptSpec } from './prompt-constructor.js';
import { resolveProfile } from '../services/profiles/index.js';

const profile = (id: string) => resolveProfile(id);

it('buildPromptSpec selects the profile identity and model-family base prompt', () => {
  expect(buildPromptSpec({ model: 'gpt-5.5', profile: profile('builtin:lite') }).basePromptContent).toBeTruthy();
  expect(buildPromptSpec({ model: 'gpt-5.5', profile: profile('builtin:standard') }).basePromptFile).toBe('gpt-5.5.md');
  expect(buildPromptSpec({ model: 'claude-3-sonnet', profile: profile('builtin:standard') }).basePromptFile).toBe(
    'anthropic.md',
  );
  expect(buildPromptSpec({ model: 'gpt-5.3-codex', profile: profile('builtin:standard') }).basePromptFile).toBe(
    'codex.md',
  );
  expect(buildPromptSpec({ model: 'gpt-4o', profile: profile('builtin:standard') }).basePromptFile).toBe(
    'simple_v4.md',
  );
});

it('buildPromptSpec routes gpt-5.6 to its own base prompt without capturing other gpt-5 versions', () => {
  expect(buildPromptSpec({ model: 'gpt-5.6', profile: profile('builtin:standard') }).basePromptFile).toBe('gpt-5.6.md');
  expect(buildPromptSpec({ model: 'gpt-5.6-2026-07-01', profile: profile('builtin:standard') }).basePromptFile).toBe(
    'gpt-5.6.md',
  );

  expect(buildPromptSpec({ model: 'gpt-5.5', profile: profile('builtin:standard') }).basePromptFile).toBe('gpt-5.5.md');
  expect(buildPromptSpec({ model: 'gpt-5.4', profile: profile('builtin:standard') }).basePromptFile).toBe(
    'gpt-5-modern.md',
  );
  expect(buildPromptSpec({ model: 'gpt-5.2', profile: profile('builtin:standard') }).basePromptFile).toBe(
    'gpt-5-modern.md',
  );
});

it('buildPromptSpec keeps gpt-5.6 codex variants on the codex base prompt', () => {
  expect(buildPromptSpec({ model: 'gpt-5.6-codex', profile: profile('builtin:standard') }).basePromptFile).toBe(
    'codex.md',
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

// it('buildPromptSpec adds GPT version fragments without changing the base GPT prompt fallback', () => {
//   const gpt55 = buildPromptSpec({ model: 'gpt-5.5-2026-04-23', liteMode: false });
//   expect(gpt55.basePromptFile).toBe('gpt-5-modern.md');
//   expect(gpt55.fragmentFiles.includes('fragments/gpt-5.5.md')).toBe(true);
//
//   const gpt54 = buildPromptSpec({ model: 'gpt-5.4', liteMode: false });
//   expect(gpt54.basePromptFile).toBe('gpt-5-modern.md');
//   expect(gpt54.fragmentFiles.includes('fragments/gpt-5.4.md')).toBe(true);
//   expect(gpt54.fragmentFiles.includes('fragments/gpt-5.4-small.md')).toBe(false);
//
//   const gpt54Mini = buildPromptSpec({ model: 'gpt-5.4-mini', liteMode: false });
//   expect(gpt54Mini.basePromptFile).toBe('gpt-5-modern.md');
//   expect(gpt54Mini.fragmentFiles.includes('fragments/gpt-5.4.md')).toBe(true);
//   expect(gpt54Mini.fragmentFiles.includes('fragments/gpt-5.4-small.md')).toBe(true);
//
//   const gpt53Codex = buildPromptSpec({ model: 'gpt-5.3-codex', liteMode: false });
//   expect(gpt53Codex.basePromptFile).toBe('codex.md');
//   expect(gpt53Codex.fragmentFiles.includes('fragments/gpt-5.3-codex.md')).toBe(true);
//
//   const genericGpt5 = buildPromptSpec({ model: 'gpt-5.2', liteMode: false });
//   expect(genericGpt5.basePromptFile).toBe('gpt-5-modern.md');
//   expect(genericGpt5.fragmentFiles.some((fragment) => fragment.startsWith('fragments/gpt-5.'))).toBe(false);
// });

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
    'mentor-mode-stub.md',
    'orchestrator-mode-stub.md',
  ]);

  expect(spec.inlineSections).toContainEqual(expect.stringContaining('## Shell Sandbox'));
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
  // Shell sandbox is added inline in lite mode (sandbox enabled by default).
  expect(lite.inlineSections.length).toBe(1);
  expect(lite.inlineSections[0]).toContain('## Shell Sandbox');
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
  expect(guidance).toContain('Do NOT call `get_shell_job` as a polling loop');
  expect(guidance.toLowerCase()).toContain('end the current turn and wait for the automatic completion notification');
  expect(guidance.toLowerCase()).toContain('do not run `sleep` merely to wait');
});

it('adds persistent-memory guidance only when memory tools are enabled', () => {
  expect(
    buildPromptSpec({ model: 'gpt-4o', profile: profile('builtin:standard'), memoryEnabled: true }).fragmentFiles,
  ).toContain('memory.md');
  expect(
    buildPromptSpec({ model: 'gpt-4o', profile: profile('builtin:standard'), memoryEnabled: false }).fragmentFiles,
  ).not.toContain('memory.md');
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
  expect(guidance).toContain('Do NOT call `get_subagent_result` immediately');
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
