import { it, expect } from 'vitest';
import { buildPromptSpec } from './prompt-constructor.js';

it('buildPromptSpec preserves mode precedence for base prompts', () => {
  expect(buildPromptSpec({ model: 'gpt-5.5', liteMode: true, orchestratorMode: true }).basePromptFile).toBe('lite.md');
  expect(buildPromptSpec({ model: 'gpt-5.5', liteMode: false, orchestratorMode: true }).basePromptFile).toBe(
    'orchestrator.md',
  );
  expect(buildPromptSpec({ model: 'claude-3-sonnet', liteMode: false }).basePromptFile).toBe('anthropic.md');
  expect(buildPromptSpec({ model: 'gpt-5.3-codex', liteMode: false }).basePromptFile).toBe('codex.md');
  expect(buildPromptSpec({ model: 'gpt-4o', liteMode: false }).basePromptFile).toBe('simple_v4.md');
});

it('buildPromptSpec routes gpt-5.6 to its own base prompt without capturing other gpt-5 versions', () => {
  expect(buildPromptSpec({ model: 'gpt-5.6', liteMode: false }).basePromptFile).toBe('gpt-5.6.md');
  expect(buildPromptSpec({ model: 'gpt-5.6-2026-07-01', liteMode: false }).basePromptFile).toBe('gpt-5.6.md');

  expect(buildPromptSpec({ model: 'gpt-5.5', liteMode: false }).basePromptFile).toBe('gpt-5.5.md');
  expect(buildPromptSpec({ model: 'gpt-5.4', liteMode: false }).basePromptFile).toBe('gpt-5-modern.md');
  expect(buildPromptSpec({ model: 'gpt-5.2', liteMode: false }).basePromptFile).toBe('gpt-5-modern.md');
});

it('buildPromptSpec keeps gpt-5.6 codex variants on the codex base prompt', () => {
  expect(buildPromptSpec({ model: 'gpt-5.6-codex', liteMode: false }).basePromptFile).toBe('codex.md');
});

it('buildPromptSpec still applies mode precedence over the gpt-5.6 profile', () => {
  expect(buildPromptSpec({ model: 'gpt-5.6', liteMode: true }).basePromptFile).toBe('lite.md');
  expect(buildPromptSpec({ model: 'gpt-5.6', liteMode: false, orchestratorMode: true }).basePromptFile).toBe(
    'orchestrator.md',
  );
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
    liteMode: false,
    mentorMode: true,
    planMode: true,
    searchViaShell: true,
  });

  expect(spec.fragmentFiles).toEqual(['worktree-hygiene.md', 'mentor-addon.md', 'plan-mode-info.md']);

  expect(spec.inlineSections).toContainEqual(expect.stringContaining('## Shell Sandbox'));
});

it('buildPromptSpec always includes plan-mode-info in standard mode to keep system prompt cache-stable', () => {
  const standard = buildPromptSpec({ model: 'gpt-4o', liteMode: false, planMode: false });
  expect(standard.fragmentFiles.includes('plan-mode-info.md')).toBe(true);
});

it('buildPromptSpec excludes plan-mode-info in lite and orchestrator modes', () => {
  const lite = buildPromptSpec({ model: 'gpt-5.5', liteMode: true, planMode: false });
  expect(lite.fragmentFiles.includes('plan-mode-info.md')).toBe(false);

  const orchestrator = buildPromptSpec({ model: 'gpt-5.5', liteMode: false, orchestratorMode: true, planMode: false });
  expect(orchestrator.fragmentFiles.includes('plan-mode-info.md')).toBe(false);
});

it('buildPromptSpec includes subagent delegation for orchestrator mode', () => {
  const orchestrator = buildPromptSpec({
    model: 'gpt-5.5',
    liteMode: false,
    orchestratorMode: true,
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
    liteMode: true,
    codeContextEnabled: true,
    searchViaShell: false,
  });
  expect(lite.basePromptFile).toBe('lite.md');
  expect(lite.fragmentFiles.includes('worktree-hygiene.md')).toBe(false);
  // Shell sandbox is added inline in lite mode (sandbox enabled by default).
  expect(lite.inlineSections.length).toBe(1);
  expect(lite.inlineSections[0]).toContain('## Shell Sandbox');
});

it('buildPromptSpec excludes shell-sandbox when sandbox is disabled', () => {
  const spec = buildPromptSpec({
    model: 'gpt-4o',
    liteMode: false,
    sandboxEnabled: false,
  });
  expect(spec.inlineSections.some((s) => s.includes('## Shell Sandbox'))).toBe(false);
  expect(spec.fragmentFiles.includes('worktree-hygiene.md')).toBe(true);
});

it('adds persistent-memory guidance only when memory tools are enabled', () => {
  expect(buildPromptSpec({ model: 'gpt-4o', liteMode: false, memoryEnabled: true }).fragmentFiles).toContain(
    'memory.md',
  );
  expect(buildPromptSpec({ model: 'gpt-4o', liteMode: false, memoryEnabled: false }).fragmentFiles).not.toContain(
    'memory.md',
  );
});

it('buildPromptSpec includes async subagent guidance when async tools are enabled', () => {
  const spec = buildPromptSpec({
    model: 'gpt-4o',
    liteMode: false,
    runSubagentAsyncEnabled: true,
  });
  expect(spec.inlineSections.some((s) => s.includes('Asynchronous subagents'))).toBe(true);
  expect(spec.inlineSections.some((s) => s.includes('run_subagent_async'))).toBe(true);
  expect(spec.inlineSections.some((s) => s.includes('get_subagent_result'))).toBe(true);
  expect(spec.inlineSections.some((s) => s.includes('explorer'))).toBe(true);
  expect(spec.inlineSections.some((s) => s.includes('researcher'))).toBe(true);
  expect(spec.inlineSections.some((s) => s.includes('mentor'))).toBe(true);
});

it('buildPromptSpec tells orchestrators to trust successful delegation and wait without duplicating it', () => {
  const spec = buildPromptSpec({
    model: 'gpt-4o',
    liteMode: false,
    orchestratorMode: true,
    runSubagentEnabled: true,
    runSubagentAsyncEnabled: true,
  });
  const guidance = spec.inlineSections.join('\n');

  expect(guidance).toContain('use `run_subagent_async` for delegable work');
  expect(guidance).toContain('A returned handle with `status: "running"` means delegation succeeded');
  expect(guidance).toContain('Do not duplicate or independently perform the delegated unit');
  expect(guidance).toContain('end the current turn and wait for the automatic completion notification');
  expect(guidance).toContain('Use `get_subagent_result` from that notification turn');
  expect(guidance).toContain('do NOT immediately call');
  expect(guidance).toContain('blocks until completion');
  expect(guidance).not.toContain('Use `run_subagent` only');
});

it('buildPromptSpec excludes async subagent guidance in lite mode', () => {
  const spec = buildPromptSpec({
    model: 'gpt-4o',
    liteMode: true,
    runSubagentAsyncEnabled: true,
  });
  expect(spec.inlineSections.some((s) => s.includes('Asynchronous subagents'))).toBe(false);
});

it('buildPromptSpec excludes async subagent guidance when disabled', () => {
  const spec = buildPromptSpec({
    model: 'gpt-4o',
    liteMode: false,
    runSubagentAsyncEnabled: false,
  });
  expect(spec.inlineSections.some((s) => s.includes('Asynchronous subagents'))).toBe(false);
});
