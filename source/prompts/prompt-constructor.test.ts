import test from 'ava';
import { buildPromptSpec } from './prompt-constructor.js';

test('buildPromptSpec preserves mode precedence for base prompts', (t) => {
  t.is(buildPromptSpec({ model: 'gpt-5.5', liteMode: true, orchestratorMode: true }).basePromptFile, 'lite.md');
  t.is(
    buildPromptSpec({ model: 'gpt-5.5', liteMode: false, orchestratorMode: true }).basePromptFile,
    'orchestrator.md',
  );
  t.is(buildPromptSpec({ model: 'claude-3-sonnet', liteMode: false }).basePromptFile, 'anthropic.md');
  t.is(buildPromptSpec({ model: 'gpt-5.3-codex', liteMode: false }).basePromptFile, 'codex.md');
  t.is(buildPromptSpec({ model: 'gpt-4o', liteMode: false }).basePromptFile, 'simple.md');
});

test('buildPromptSpec includes ask_user guidance in all modes', (t) => {
  const standard = buildPromptSpec({ model: 'gpt-4o', liteMode: false });
  t.true(standard.inlineSections.some((s) => s.includes('ask_user')));

  const lite = buildPromptSpec({ model: 'gpt-4o', liteMode: true });
  t.true(lite.inlineSections.some((s) => s.includes('ask_user')));

  const orchestrator = buildPromptSpec({
    model: 'gpt-4o',
    liteMode: false,
    orchestratorMode: true,
    runSubagentEnabled: true,
  });
  t.true(orchestrator.inlineSections.some((s) => s.includes('ask_user')));
});

// test('buildPromptSpec adds GPT version fragments without changing the base GPT prompt fallback', (t) => {
//   const gpt55 = buildPromptSpec({ model: 'gpt-5.5-2026-04-23', liteMode: false });
//   t.is(gpt55.basePromptFile, 'gpt-5-modern.md');
//   t.true(gpt55.fragmentFiles.includes('fragments/gpt-5.5.md'));
//
//   const gpt54 = buildPromptSpec({ model: 'gpt-5.4', liteMode: false });
//   t.is(gpt54.basePromptFile, 'gpt-5-modern.md');
//   t.true(gpt54.fragmentFiles.includes('fragments/gpt-5.4.md'));
//   t.false(gpt54.fragmentFiles.includes('fragments/gpt-5.4-small.md'));
//
//   const gpt54Mini = buildPromptSpec({ model: 'gpt-5.4-mini', liteMode: false });
//   t.is(gpt54Mini.basePromptFile, 'gpt-5-modern.md');
//   t.true(gpt54Mini.fragmentFiles.includes('fragments/gpt-5.4.md'));
//   t.true(gpt54Mini.fragmentFiles.includes('fragments/gpt-5.4-small.md'));
//
//   const gpt53Codex = buildPromptSpec({ model: 'gpt-5.3-codex', liteMode: false });
//   t.is(gpt53Codex.basePromptFile, 'codex.md');
//   t.true(gpt53Codex.fragmentFiles.includes('fragments/gpt-5.3-codex.md'));
//
//   const genericGpt5 = buildPromptSpec({ model: 'gpt-5.2', liteMode: false });
//   t.is(genericGpt5.basePromptFile, 'gpt-5-modern.md');
//   t.false(genericGpt5.fragmentFiles.some((fragment) => fragment.startsWith('fragments/gpt-5.')));
// });

test('buildPromptSpec composes file fragments in stable order', (t) => {
  const spec = buildPromptSpec({
    model: 'gpt-5.4-mini',
    liteMode: false,
    mentorMode: true,
    planMode: true,
    searchViaShell: true,
  });

  t.deepEqual(spec.fragmentFiles, [
    // 'fragments/gpt-5.4.md',
    'fragments/gpt-5.4-small.md',
    'worktree-hygiene.md',
    'mentor-addon.md',
    'plan-mode-info.md',
  ]);
});

test('buildPromptSpec always includes plan-mode-info in standard mode to keep system prompt cache-stable', (t) => {
  const standard = buildPromptSpec({ model: 'gpt-4o', liteMode: false, planMode: false });
  t.true(standard.fragmentFiles.includes('plan-mode-info.md'));
});

test('buildPromptSpec excludes plan-mode-info in lite and orchestrator modes', (t) => {
  const lite = buildPromptSpec({ model: 'gpt-5.5', liteMode: true, planMode: false });
  t.false(lite.fragmentFiles.includes('plan-mode-info.md'));

  const orchestrator = buildPromptSpec({ model: 'gpt-5.5', liteMode: false, orchestratorMode: true, planMode: false });
  t.false(orchestrator.fragmentFiles.includes('plan-mode-info.md'));
});

test('buildPromptSpec includes code context inline section when enabled and not orchestrator', (t) => {
  const standard = buildPromptSpec({
    model: 'gpt-4o',
    liteMode: false,
    codeContextEnabled: true,
    searchViaShell: false,
  });
  t.true(standard.inlineSections.length > 0);
  t.true(standard.inlineSections.some((s) => s.includes('Code Context')));

  const gpt5 = buildPromptSpec({
    model: 'gpt-5.5',
    liteMode: false,
    codeContextEnabled: true,
    searchViaShell: false,
  });
  t.true(gpt5.inlineSections.some((s) => s.includes('Code Context')));
});

test('buildPromptSpec includes subagent delegation for orchestrator mode', (t) => {
  const orchestrator = buildPromptSpec({
    model: 'gpt-5.5',
    liteMode: false,
    orchestratorMode: true,
    runSubagentEnabled: true,
    codeContextEnabled: true,
    searchViaShell: false,
  });
  t.true(orchestrator.inlineSections.some((s) => s.includes('Delegating to subagents')));
  t.false(orchestrator.inlineSections.some((s) => s.includes('Code Context')));
});

test('buildPromptSpec uses lite base and skips worktree-hygiene fragment in lite mode', (t) => {
  const lite = buildPromptSpec({
    model: 'gpt-5.5',
    liteMode: true,
    codeContextEnabled: true,
    searchViaShell: false,
  });
  t.is(lite.basePromptFile, 'lite.md');
  t.false(lite.fragmentFiles.includes('worktree-hygiene.md'));
  t.true(lite.inlineSections.some((s) => s.includes('Search Tools')));
});
