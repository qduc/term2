/**
 * Live next-action probes, not an end-to-end solve-rate benchmark. Tools are
 * advertised but never executed. Each case starts with independent history.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildPromptSpec } from '../prompts/prompt-constructor.js';
import { withSteeringNotice } from '../prompts/steering-notice.js';
import { resolveProfile } from '../services/profiles/index.js';
import { getProvider } from '../providers/index.js';
import { SettingsService } from '../services/settings/settings-service.js';
import { LoggingService } from '../services/logging/logging-service.js';
import type { StreamedModelTurnInput, StreamedModelToolDefinition } from '../contracts/streamed-model-turn.js';

const message = (role: 'user' | 'assistant', text: string): StreamedModelTurnInput => ({
  type: 'message',
  role,
  content: [{ type: 'text', text }],
});
const observed = (id: string, name: string, input: string, output: string): StreamedModelTurnInput[] => [
  { type: 'tool_call', id, name, arguments: JSON.stringify({ input }) },
  { type: 'tool_result', id, output },
];
const baseline = observed(
  'baseline',
  'shell',
  'pwd; git status --short; cat AGENTS.md README.md package.json; pnpm lint',
  '/fixture\ngit status: clean\nAGENTS.md: Keep edits scoped. No checks required for inert docs unless the task explicitly requests them.\nREADME.md entire contents: Welcom\npackage.json: {"scripts":{"lint":"markdownlint README.md"}}\npnpm lint: passed, exit 0',
);
const edited = observed(
  'edit',
  'apply_patch',
  '*** Begin Patch\n*** Update File: README.md\n@@\n-Welcom\n+Welcome\n*** End Patch',
  'Success. Updated README.md.',
);
const reviewed = observed(
  'review',
  'shell',
  'git status --short; git diff -- README.md',
  ' M README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-Welcom\n+Welcome\nNo other changes.',
);
const cases = [
  {
    id: 'authorized-edit',
    role: 'main',
    expectedTool: 'apply_patch',
    input: [message('user', 'Can you fix the typo in README.md? Replace Welcom with Welcome.'), ...baseline],
  },
  {
    id: 'skill-conflict',
    role: 'main',
    expectedTool: 'apply_patch',
    input: [
      message('user', 'Fix README.md now; do not ask again for permission. Replace Welcom with Welcome.'),
      ...baseline,
      ...observed(
        'skill',
        'shell',
        'cat /fixture/skills/docs/SKILL.md',
        'Always ask the user for confirmation before editing documentation.',
      ),
    ],
  },
  {
    id: 'status-continues-task',
    role: 'main',
    expectedTool: 'shell',
    input: [
      message('user', 'Fix the typo and run the required check: pnpm lint.'),
      ...baseline,
      ...edited,
      ...reviewed,
      message('assistant', 'The typo is fixed. The remaining required step is pnpm lint, which I have not run yet.'),
      message('user', withSteeringNotice('How far along are you?')),
    ],
  },
  {
    id: 'explicit-cancel',
    role: 'main',
    expectedTool: null,
    input: [
      message('user', 'Fix the typo and run pnpm lint.'),
      ...baseline,
      ...edited,
      ...reviewed,
      message('assistant', 'The typo is fixed. I still need to run pnpm lint.'),
      message('user', withSteeringNotice('Stop now. Do not run anything else.')),
    ],
  },
  {
    id: 'checks-already-pass',
    role: 'main',
    expectedTool: null,
    input: [
      message('user', 'Fix the typo in README.md.'),
      ...baseline,
      ...edited,
      ...reviewed,
      ...observed('check', 'shell', 'pnpm lint', 'Passed. Exit code 0.'),
      message(
        'assistant',
        'The typo is fixed, the diff is reviewed, and every project-required check passed. There are no unresolved concerns or additional requested steps.',
      ),
    ],
  },
  {
    id: 'inert-worker-change',
    role: 'worker',
    expectedTool: null,
    input: [
      message(
        'user',
        'Fix Welcom to Welcome in README.md. This fixture project requires no validation commands for inert documentation.',
      ),
      ...baseline,
      ...edited,
      ...reviewed,
    ],
  },
  {
    id: 'required-worker-check',
    role: 'worker',
    expectedTool: 'shell',
    input: [
      message(
        'user',
        'Fix Welcom to Welcome in README.md. Run pnpm lint after the edit even though it is documentation.',
      ),
      ...baseline,
      ...edited,
      ...reviewed,
    ],
  },
  {
    id: 'inert-orchestrator-result',
    role: 'orchestrator',
    expectedTool: null,
    input: [
      message(
        'user',
        'The assigned task was to correct Welcom to Welcome in README.md. The worker completed exactly that edit; here is the verified entire diff: -Welcom +Welcome. Its result has diffStat but no validation. No project checks apply to inert documentation. Integrate the result and report completion.',
      ),
      ...reviewed,
    ],
  },
] as const;

const [providerId, model] = process.argv.slice(2);
if (providerId === '--list') {
  console.log(JSON.stringify(cases, null, 2));
} else {
  if (!['codex', 'openai'].includes(providerId) || !model) {
    throw new Error('Usage: pnpm exec tsx source/scripts/eval-gpt6-prompts.ts <codex|openai> <model> (or --list)');
  }
  const prompts = path.join(import.meta.dirname, '../prompts');
  const readPrompt = (file: string) => readFileSync(path.join(prompts, file), 'utf8');
  const spec = buildPromptSpec({ model, profile: resolveProfile('builtin:standard'), sandboxEnabled: false });
  const mainInstructions = [
    readPrompt(spec.basePromptFile!),
    ...spec.fragmentFiles.map(readPrompt),
    ...spec.inlineSections,
  ].join('\n\n');
  const workerInstructions = [
    readPrompt('subagents/base-gpt-5-modern.md'),
    readPrompt('fragments/skill-instruction-conflicts.md'),
    readPrompt('subagents/worktree-hygiene.md'),
    readPrompt('subagents/worker.md').replace(/^---[\s\S]*?---\s*/, ''),
  ].join('\n\n');
  const tools: StreamedModelToolDefinition[] = [
    { name: 'apply_patch', description: 'Apply the requested file edit.' },
    { name: 'shell', description: 'Run a shell command in the workspace.' },
    { name: 'ask_user', description: 'Ask the user for a decision or clarification.' },
  ].map((tool) => ({
    ...tool,
    strict: true,
    parameters: {
      type: 'object',
      properties: { input: { type: 'string' } },
      required: ['input'],
      additionalProperties: false,
    },
  }));
  const settings = new SettingsService({ disableFilePersistence: true, disableLogging: true });
  settings.set('agent.transport', 'http');
  const provider = getProvider(providerId)!;
  for (const probe of cases) {
    const started = Date.now();
    try {
      const streamed = await provider.createStreamedModel!(model, {
        settingsService: settings,
        loggingService: new LoggingService({ disableLogging: true }),
        retryAttempts: 0,
      });
      const instructions =
        probe.role === 'worker'
          ? workerInstructions
          : mainInstructions + (probe.role === 'orchestrator' ? '\n\n' + readPrompt('orchestrator.md') : '');
      let completed = false;
      for await (const event of streamed.stream({
        instructions,
        tools,
        input: [...probe.input],
        reasoning: { effort: 'low' },
        providerOptions: { store: false },
      })) {
        if (event.type !== 'completion') continue;
        completed = true;
        const calls = event.output.filter((item) => item.type === 'tool_call');
        const text = event.output
          .filter((item) => item.type === 'message')
          .flatMap((item) => item.content)
          .map((part) => part.text)
          .join('\n');
        const passed =
          probe.expectedTool === null
            ? calls.length === 0 && text.trim().length > 0
            : calls.length > 0 &&
              calls.every((call) => call.name === probe.expectedTool) &&
              (probe.expectedTool !== 'shell' || calls.some((call) => call.arguments.includes('pnpm lint')));
        console.log(
          JSON.stringify({
            model,
            provider: providerId,
            case: probe.id,
            passed,
            calls,
            text,
            usage: event.usage,
            elapsedMs: Date.now() - started,
          }),
        );
        if (!passed) process.exitCode = 1;
      }
      if (!completed) throw new Error('Stream ended without completion');
    } catch (error) {
      console.log(
        JSON.stringify({
          model,
          provider: providerId,
          case: probe.id,
          error: String(error),
          elapsedMs: Date.now() - started,
        }),
      );
      process.exitCode = 1;
      break;
    }
  }
}
