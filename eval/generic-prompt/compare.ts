/** Paired inert next-action probe. Tool calls are recorded, never executed. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPromptSpec } from '../../source/prompts/prompt-constructor.js';
import { resolveProfile } from '../../source/services/profiles/index.js';
import { getProvider } from '../../source/providers/index.js';
import { SettingsService } from '../../source/services/settings/settings-service.js';
import { LoggingService } from '../../source/services/logging/logging-service.js';
import { mainProbeTools } from '../../source/scripts/gpt6-probe-tools.js';
import type { StreamedModelTurnInput } from '../../source/contracts/streamed-model-turn.js';

const message = (role: 'user' | 'assistant', text: string): StreamedModelTurnInput => ({
  type: 'message', role, content: [{ type: 'text', text }],
});
const observed = (id: string, name: string, args: object, output: string): StreamedModelTurnInput[] => [
  { type: 'reasoning', text: 'I should use the available tool for this step.',
    providerMetadata: { openai_compatible_reasoning_content: true } },
  { type: 'tool_call', id, name, arguments: JSON.stringify(args) },
  { type: 'tool_result', id, output },
];
const fixture = observed('inspect', 'shell', { command: 'pwd; git status --short; cat AGENTS.md README.md package.json; pnpm lint' },
  '/fixture\ngit status: clean\nAGENTS.md: Keep edits scoped. README.md: Welcom\npackage.json: {"scripts":{"lint":"markdownlint README.md"}}\npnpm lint: passed, exit 0');
const edit = observed('edit', 'run_code', {
  code: 'return await tools.apply_patch({patch:"*** Begin Patch\\n*** Update File: README.md\\n@@\\n-Welcom\\n+Welcome\\n*** End Patch"});',
  description: 'Fix README typo',
}, 'Updated README.md.');
const afterEdit: StreamedModelTurnInput[] = [
  { type: 'reasoning', text: 'I should finish the promised validation.',
    providerMetadata: { openai_compatible_reasoning_content: true } },
  message('assistant', 'The edit is done, but pnpm lint has not run after it yet.'),
];
const cases: { id: string; input: StreamedModelTurnInput[]; expected: string | null }[] = [
  { id: 'direct-edit', expected: 'run_code', input: [message('user', 'Fix Welcom to Welcome in README.md.'), ...fixture] },
  { id: 'desired-state', expected: 'run_code', input: [message('user', 'README.md should say Welcome instead of Welcom.'), ...fixture] },
  { id: 'question-edit', expected: 'run_code', input: [message('user', 'Can we make README.md say Welcome instead of Welcom?'), ...fixture] },
  { id: 'read-only', expected: null, input: [message('user', 'Do not edit files. Just explain how to replace Welcom with Welcome in README.md.'), ...fixture] },
  { id: 'required-check', expected: 'shell', input: [message('user', 'Fix Welcom to Welcome and run pnpm lint.'), ...fixture, ...edit,
    ...afterEdit] },
];

const prompts = join(import.meta.dirname, '../../source/prompts');
const readPrompt = (file: string) => readFileSync(join(prompts, file), 'utf8');
const control = readFileSync(join(import.meta.dirname, 'simple_v4.md'), 'utf8');
const candidate = readPrompt('gpt.md');
const models = [{ provider: 'zai', model: 'glm-5.3-flash' }, { provider: 'DeepSeek', model: 'deepseek-flash' }];
const settings = new SettingsService({ disableFilePersistence: true, disableLogging: true });
settings.set('agent.transport', 'http');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const specs = models.map(({ provider, model }) => {
  const spec = buildPromptSpec({ model, profile: resolveProfile('builtin:standard'), sandboxEnabled: false, runCodeEnabled: true });
  const rest = [...spec.fragmentFiles.map(readPrompt), ...spec.inlineSections].join('\n\n');
  return { provider, model, baseFile: spec.basePromptFile, rest, controlInstructions: [control, rest].join('\n\n'),
    candidateInstructions: [candidate, rest].join('\n\n') };
});

if (process.argv[2] === '--dry-run') {
  for (const s of specs) console.log(JSON.stringify({ provider: s.provider, model: s.model,
    registered: Boolean(getProvider(s.provider)?.createStreamedModel), baseFile: s.baseFile,
    controlHash: hash(s.controlInstructions), candidateHash: hash(s.candidateInstructions),
    commonRestHash: hash(s.rest), cases: cases.map(c => c.id), trials: 2, effort: 'medium' }));
} else if (process.argv[2] === '--go') {
  const selected = specs.filter(s => !process.argv[3] || s.provider === process.argv[3]);
  const selectedCases = cases.filter(c => !process.argv[4] || c.id === process.argv[4]);
  if (!selected.length || !selectedCases.length) throw new Error('Unknown provider or case');
  for (const s of selected) {
    const provider = getProvider(s.provider);
    if (!provider?.createStreamedModel) throw new Error(`Provider unavailable: ${s.provider}`);
    if (s.baseFile !== 'simple_v4.md') throw new Error(`Unexpected generic base: ${s.baseFile}`);
    for (let trial = 0; trial < 2; trial++) {
      for (const c of selectedCases) {
        for (const arm of trial === 0 ? ['control', 'candidate'] as const : ['candidate', 'control'] as const) {
          const started = Date.now();
          try {
            const streamed = await provider.createStreamedModel(s.model, {
              settingsService: settings, loggingService: new LoggingService({ disableLogging: true }), retryAttempts: 0,
              signal: AbortSignal.timeout(90000),
            });
            let completed = false;
            for await (const event of streamed.stream({
              instructions: arm === 'control' ? s.controlInstructions : s.candidateInstructions,
              tools: mainProbeTools, input: [...c.input], reasoning: { effort: 'medium' },
              providerOptions: { store: false },
            })) {
              if (event.type !== 'completion') continue;
              completed = true;
              const calls = event.output.filter(item => item.type === 'tool_call');
              const text = event.output.filter(item => item.type === 'message')
                .flatMap(item => item.content).map(part => part.text).join('\n');
              const editAttempted = calls.some(call => call.name === 'run_code' &&
                /tools\.(apply_patch|search_replace|create_file)\s*\(/.test(JSON.parse(call.arguments).code ?? ''));
              const passed = c.expected === null ? calls.length === 0 && text.trim().length > 0
                : calls.length > 0 && calls.every(call => call.name === c.expected) &&
                  (!['direct-edit', 'desired-state', 'question-edit'].includes(c.id) || editAttempted) &&
                  (c.expected !== 'shell' || calls.some(call => JSON.parse(call.arguments).command?.includes('pnpm lint')));
              console.log(JSON.stringify({ provider: s.provider, model: s.model, trial, case: c.id, arm, passed,
                editAttempted, calls, text, usage: event.usage, elapsedMs: Date.now() - started }));
            }
            if (!completed) throw new Error('Stream ended without completion');
          } catch (error) {
            console.log(JSON.stringify({ provider: s.provider, model: s.model, trial, case: c.id, arm,
              error: String(error), elapsedMs: Date.now() - started }));
            process.exitCode = 1;
          }
        }
      }
    }
  }
} else {
  throw new Error('Usage: pnpm exec tsx eval/generic-prompt/compare.ts <--dry-run|--go>');
}
