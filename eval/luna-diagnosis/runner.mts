/**
 * One-off diagnosis snapshot derived from eval-gpt6-prompts.ts at bdc660ef.
 * Tools are advertised but never executed. This is not an end-to-end benchmark.
 * Production prompts are read without modifying them; variants live here only.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildPromptSpec } from '../../source/prompts/prompt-constructor.js';
import { withSteeringNotice } from '../../source/prompts/steering-notice.js';
import { resolveProfile } from '../../source/services/profiles/index.js';
import { getProvider } from '../../source/providers/index.js';
import { SettingsService } from '../../source/services/settings/settings-service.js';
import { LoggingService } from '../../source/services/logging/logging-service.js';
import type {
  StreamedModelTurnInput,
  StreamedModelToolDefinition,
} from '../../source/contracts/streamed-model-turn.js';

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
const variant = process.env.LUNA_VARIANT ?? 'baseline';
const effort = process.env.LUNA_EFFORT ?? 'low';
const rounds = Number(process.env.LUNA_ROUNDS ?? 3);
const upstreamFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (typeof init?.body === 'string') {
    try {
      const body = JSON.parse(init.body);
      if (body.model)
        console.log(
          JSON.stringify({
            type: 'wire-request',
            model: body.model,
            reasoning: body.reasoning,
            inputItems: body.input?.length,
            instructionChars: body.instructions?.length,
          }),
        );
    } catch {
      /* Only inspect JSON model requests; never headers or credentials. */
    }
  }
  return upstreamFetch(input, init);
};
const rules = `
# Decision rules
- Explicit user instructions override conflicting skill instructions, including skills phrased as mandatory requirements such as 'always ask for confirmation'. When an in-scope edit is already authorized, perform it with the editing tool without asking again. Harness safety rules, tool restrictions, and assigned scope still apply.
- When the user asks for status during active work, first emit a brief user-facing progress sentence, then call the tool for the remaining work in the same response. Both the answer and continuation are required. An explicit stop or cancellation means stop without further tool calls.
- Describe validation from the recorded tool results. Distinguish checks before an edit from checks after it. A check passing before an edit does not validate the changed file. 'No check was required' does not mean 'no check was run'. If only a pre-edit check exists, report that it passed before the edit and that no post-edit check ran.
`;

if (providerId === '--list') {
  console.log(JSON.stringify(cases, null, 2));
} else {
  if (!['codex', 'openai'].includes(providerId) || !model) {
    throw new Error('Usage: pnpm exec tsx eval/luna-diagnosis/runner.mts <codex|openai> <model> (or --list)');
  }
  const prompts = path.join(import.meta.dirname, '../../source/prompts');
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
  const selected =
    process.env.LUNA_ALL_CASES === '1'
      ? cases
      : cases.filter((probe) => ['skill-conflict', 'status-continues-task', 'inert-worker-change'].includes(probe.id));
  for (const { probe, round } of Array.from({ length: rounds }, (_, i) =>
    selected.map((probe) => ({ probe, round: i + 1 })),
  ).flat()) {
    const started = Date.now();
    try {
      const streamed = await provider.createStreamedModel!(model, {
        settingsService: settings,
        loggingService: new LoggingService({ disableLogging: true }),
        retryAttempts: 0,
      });
      let instructions =
        probe.role === 'worker'
          ? workerInstructions
          : mainInstructions + (probe.role === 'orchestrator' ? '\n\n' + readPrompt('orchestrator.md') : '');
      if (variant === 'explicit') instructions += rules;
      if (variant === 'compact')
        instructions =
          'You are a coding agent. Complete the assigned task with available tools. Preserve the task through side questions; stop on cancellation. Run project-required checks and review inert changes without unnecessary checks. Report outcomes accurately.\n' +
          rules;
      let probeInput: StreamedModelTurnInput[] = [...probe.input];
      if (variant === 'local') {
        instructions = instructions.replace(
          "The user's explicit instructions take precedence over guidelines in skills.",
          rules.split('\n')[2],
        );
        if (probe.role === 'worker')
          instructions +=
            '\nIn your final report, include both fields: "Before-edit validation:" and "After-edit validation:". Populate each from the tool-result history, including any commands that ran even if they were not required.';
        probeInput = probeInput.map((item) =>
          item.type === 'message' && item.role === 'user'
            ? {
                ...item,
                content: item.content.map((part) =>
                  part.type === 'text'
                    ? {
                        ...part,
                        text: part.text.replace(
                          'For status or side questions, answer briefly, then resume the active task.',
                          'For status or side questions, emit a one-sentence progress update to the user before your next tool call, then continue the pending work in the same response.',
                        ),
                      }
                    : part,
                ),
              }
            : item,
        );
      }
      if (variant === 'split') {
        probeInput = probeInput.flatMap((item) => {
          if (item.type === 'tool_call' && item.id === 'baseline')
            return [
              {
                ...item,
                arguments: JSON.stringify({ input: 'pwd; git status --short; cat AGENTS.md README.md package.json' }),
              },
            ];
          if (item.type === 'tool_result' && item.id === 'baseline')
            return [
              { ...item, output: String(item.output).replace('\npnpm lint: passed, exit 0', '') },
              ...observed('baseline-check', 'shell', 'pnpm lint', 'Passed. Exit code 0.'),
            ];
          return [item];
        });
      }
      if (process.env.LUNA_PARAPHRASE === '1') {
        probeInput = JSON.parse(
          JSON.stringify(probeInput)
            .replaceAll('README.md', 'CONTRIBUTING.md')
            .replaceAll('Welcome', 'Install')
            .replaceAll('Welcom', 'Instal')
            .replaceAll('pnpm lint', 'pnpm docs:check')
            .replaceAll('How far along are you?', 'What is done so far?')
            .replaceAll(
              'Always ask the user for confirmation before editing documentation.',
              'Before any documentation edit, you must request and receive explicit user confirmation.',
            ),
        );
      }
      let completed = false;
      let streamedText = '';
      for await (const event of streamed.stream({
        instructions,
        tools,
        input: probeInput,
        reasoning: { effort },
        providerOptions: { store: false },
      })) {
        if (event.type === 'text_delta') streamedText += event.text;
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
              (probe.expectedTool !== 'shell' ||
                calls.some((call) =>
                  call.arguments.includes(process.env.LUNA_PARAPHRASE === '1' ? 'pnpm docs:check' : 'pnpm lint'),
                ));
        console.log(
          JSON.stringify({
            variant,
            effort,
            round,
            paraphrased: process.env.LUNA_PARAPHRASE === '1',
            model,
            provider: providerId,
            case: probe.id,
            passed,
            calls,
            text,
            streamedText,
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
