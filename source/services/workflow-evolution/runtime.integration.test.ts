import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApplicationRunLoop } from '../agent-runtime/application-run-loop.js';
import { SkillsService } from '../skills/skills-service.js';
import { createActivateSkillToolDefinition } from '../../tools/agent/activate-skill.js';
import { createRunSubagentToolDefinition } from '../../tools/agent/run-subagent.js';
import { createSubagentRuntime } from '../subagents/runtime.js';
import { ToolOwnershipRegistry } from '../approval/tool-ownership-registry.js';
import {
  createMockLogger,
  createMockSettings,
  createMockExecutionContext,
  createSessionContextService,
  registerTestProvider,
} from '../subagents/test-helpers/subagent-manager-fixtures.js';
import type { StreamedModelTurn, StreamedModelTurnRequest } from '../../contracts/streamed-model-turn.js';
import type { NestedSubagentResult } from '../subagents/types.js';
import type { ToolDefinition, AnyToolDefinition } from '../../tools/types.js';
import type { ToolInvocationContext } from '../agent-runtime/tool-invocation-context.js';
import { appendEvent, readLedger } from './ledger.js';
import { contentDigest, digest, type ExperimentEvent, type Method, type RunRecord } from './experiment.js';

type Review = Extract<ExperimentEvent, { type: 'compare' }>;
const tasks = [
  { id: 'a', input: '## Setup\n## Setup', expected: 'setup\nsetup-1' },
  { id: 'b', input: '## Usage\n## Usage', expected: 'usage\nusage-1' },
  { id: 'c', input: '## Build\n## Build', expected: 'build\nbuild-1' },
];
const originalBody = 'Return lowercase heading anchors.';
const candidateBody = 'Return lowercase heading anchors; suffix duplicate anchors.';
const skillFile = (body: string) => `---\nname: toc\ndescription: Build a TOC\n---\n${body}\n`;

function resultText(request: StreamedModelTurnRequest, name: string): string | undefined {
  const call = [...request.input].reverse().find((item) => item.type === 'tool_call' && item.name === name);
  const result =
    call?.type === 'tool_call'
      ? [...request.input].reverse().find((item) => item.type === 'tool_result' && item.id === call.id)
      : undefined;
  return result?.type === 'tool_result'
    ? typeof result.output === 'string'
      ? result.output
      : result.output.map((part) => (part.type === 'text' ? part.text : '')).join('')
    : undefined;
}
function scriptedCall(name: string, id: string, args: unknown) {
  return { type: 'tool_call' as const, name, id, arguments: JSON.stringify(args) };
}

it('runs actual activation, fresh Reviewer dispatch, host-approved local reload and next activation with deterministic boundaries', async () => {
  const root = await mkdtemp(join(os.tmpdir(), 'term2-evolution-runtime-'));
  try {
    vi.spyOn(os, 'homedir').mockReturnValue(join(root, 'empty-home'));
    const skillPath = join(root, '.agents/skills/toc/SKILL.md');
    const candidatePath = join(root, 'candidate/SKILL.md');
    await mkdir(join(root, '.agents/skills/toc'), { recursive: true });
    await mkdir(join(root, 'candidate'), { recursive: true });
    await writeFile(skillPath, skillFile(originalBody));
    await writeFile(candidatePath, skillFile(candidateBody));
    const logger = createMockLogger();
    const skills = new SkillsService(logger, root);
    skills.discoverSkills();
    const ledger = join(root, 'experiment.json');
    const harnessRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const conditions = 'scripted provider; real activation/runloop/reviewer; isolated artifacts; no retries';
    const criteria = {
      tasks: tasks.map((task) => ({ id: task.id, inputDigest: digest(task.input) })),
      checks: ['exact-anchors', 'input-preserved'],
      conditions,
      minimumPairs: 3,
      minimumWins: 2,
    };
    const runFiles = new Map<
      string,
      { task: (typeof tasks)[number]; input: string; artifact: string; trace: string; loaded: Method }
    >();
    const mainRequests: StreamedModelTurnRequest[] = [];
    const reviewerRequests: StreamedModelTurnRequest[] = [];
    const explorerTasks: string[] = [];
    let reviewResult: NestedSubagentResult | undefined;
    let revision = 'v1';
    let activation: { snapshot: Method; returned: string } | undefined;
    const realActivate = createActivateSkillToolDefinition(skills);
    // Observe the real tool result; never synthesize a loaded-body receipt.
    const activate: typeof realActivate = {
      ...realActivate,
      execute: async (args, context, details) => {
        const returned = String(await realActivate.execute(args, context, details));
        const marker = '\n\nSkill directory: ';
        const start = returned.indexOf('\n') + 1;
        const end = returned.indexOf(marker);
        expect(end).toBeGreaterThan(start);
        const directory = returned.slice(end + marker.length).split('\n')[0];
        activation = {
          returned,
          snapshot: { name: 'toc', revision, source: join(directory, 'SKILL.md'), body: returned.slice(start, end) },
        };
        return returned;
      },
    };

    const reviewerModel: StreamedModelTurn = {
      async *stream(request) {
        reviewerRequests.push({ ...request, input: structuredClone(request.input) });
        expect(request.tools.map((tool) => tool.name)).toEqual(['run_explorer']);
        expect(JSON.stringify(request.input)).not.toContain('MAIN_PRIVATE_SENTINEL');
        const facts = resultText(request, 'run_explorer');
        if (!facts) {
          const call = scriptedCall('run_explorer', 'reviewer-evidence', {
            task: `Read the frozen artifact pairs and report exact-anchor/input-preservation facts in ${root}.`,
          });
          yield call;
          yield { type: 'completion', responseId: 'reviewer-evidence-response', output: [call] };
        } else {
          // Mock provider response is constrained to facts returned by the actual tool boundary.
          expect(facts.split('\n')[0]).toBe('Status: completed');
          const observedPairs = JSON.parse(facts.split('\n\n')[1]) as Review['pairs'];
          yield {
            type: 'completion',
            responseId: 'reviewer-verdict',
            output: [{ type: 'message', content: [{ type: 'text', text: JSON.stringify({ pairs: observedPairs }) }] }],
          };
        }
      },
    };
    const providerId = registerTestProvider({ createStreamedModel: () => reviewerModel });
    const settings = createMockSettings({
      'agent.modelSelection': { model: 'fixture', provider: providerId },
      'memory.enabled': false,
    });
    const runtime = createSubagentRuntime({
      logger,
      settings,
      skillsService: skills,
      sessionContextService: createSessionContextService(),
      executionContext: createMockExecutionContext(root),
      toolOwnership: new ToolOwnershipRegistry(),
    });
    // Mock only the explorer tool boundary; the Reviewer role, context, tool policy
    // and nested application run loop are production implementations.
    runtime.toolFactory.setExplorerRunner(async (task) => {
      explorerTasks.push(task);
      const pairs: Review['pairs'] = [];
      for (const frozen of tasks) {
        const inspect = async (id: string) => {
          const files = runFiles.get(id)!;
          const input = await readFile(files.input, 'utf8');
          const output = await readFile(files.artifact, 'utf8');
          const exact = output === frozen.expected ? ('pass' as const) : ('fail' as const);
          const preserved = input === frozen.input ? ('pass' as const) : ('fail' as const);
          return {
            metrics: {
              outcome: exact === 'pass' && preserved === 'pass' ? ('pass' as const) : ('fail' as const),
              interventions: 0,
              retries: 0,
            },
            exact,
            preserved,
          };
        };
        const base = await inspect(`${frozen.id}-base`);
        const next = await inspect(`${frozen.id}-candidate`);
        const report = join(root, `${frozen.id}-independent-facts.json`);
        const bytes = JSON.stringify({ task: frozen, base, next });
        await writeFile(report, bytes);
        pairs.push({
          incumbentRunId: `${frozen.id}-base`,
          candidateRunId: `${frozen.id}-candidate`,
          incumbent: base.metrics,
          candidate: next.metrics,
          checks: [
            { id: 'exact-anchors', incumbent: base.exact, candidate: next.exact },
            { id: 'input-preserved', incumbent: base.preserved, candidate: next.preserved },
          ],
          evidence: [{ ref: report, digest: contentDigest(bytes) }],
        });
      }
      return {
        agentId: 'mock-explorer-boundary',
        role: 'explorer',
        status: 'completed',
        finalText: JSON.stringify(pairs),
        filesChanged: [],
        toolsUsed: [{ toolName: 'fixture_artifact_read', count: 6 }],
      };
    });
    const delegate = createRunSubagentToolDefinition(async (params, context, details) => {
      reviewResult = await runtime.nestedRunner.runAsTool({ role: params.role!, task: params.task! }, context, details);
      return reviewResult;
    });

    async function mainRun(
      id: string,
      output: string,
      tool: AnyToolDefinition = activate,
      args: unknown = { name: 'toc' },
    ) {
      activation = undefined;
      const model: StreamedModelTurn = {
        async *stream(request) {
          mainRequests.push({ ...request, input: structuredClone(request.input) });
          if (!resultText(request, tool.name)) {
            const call = scriptedCall(tool.name, `${id}-call`, args);
            yield call;
            yield { type: 'completion', responseId: `${id}-tool`, output: [call] };
          } else {
            yield {
              type: 'completion',
              responseId: `${id}-done`,
              output: [{ type: 'message', content: [{ type: 'text', text: output }] }],
            };
          }
        },
      };
      const loop = new ApplicationRunLoop({ resolveModel: () => model });
      const stream = loop.startStream(
        { name: 'main', instructions: 'Perform the bounded task.', model: 'fixture', tools: [tool] },
        `MAIN_PRIVATE_SENTINEL ${id}`,
        { sessionId: `main-${id}`, maxTurns: 4 },
      );
      await stream.completed;
      return { stream, loop };
    }
    async function stage(body: string, version: string) {
      await writeFile(skillPath, skillFile(body));
      skills.discoverSkills();
      revision = version;
    }
    await mainRun('capture-incumbent', 'captured');
    const incumbent = activation!.snapshot;
    await appendEvent(ledger, { type: 'init', id: 'runtime-experiment', incumbent, criteria });
    async function work(id: string, purpose: 'work' | 'benchmark', task: (typeof tasks)[number], output: string) {
      const { stream } = await mainRun(id, output);
      expect(stream.interruptions).toHaveLength(0);
      const receipt = activation!;
      const input = join(root, `${id}.md`);
      const artifact = join(root, `${id}.anchors`);
      const trace = join(root, `${id}.activation.json`);
      await writeFile(input, task.input);
      await writeFile(artifact, stream.finalOutput as string);
      const traceBytes = JSON.stringify({ toolResult: receipt.returned, snapshot: receipt.snapshot });
      await writeFile(trace, traceBytes);
      runFiles.set(id, { task, input, artifact, trace, loaded: receipt.snapshot });
      const record: RunRecord = {
        type: 'run',
        id,
        purpose,
        taskId: task.id,
        inputDigest: digest(task.input),
        loadedMethod: receipt.snapshot,
        methodId: digest(receipt.snapshot),
        harnessRevision,
        conditionsId: digest(conditions),
        actor: { role: 'main', sessionId: `main-${id}` },
        metrics: { outcome: stream.finalOutput === task.expected ? 'pass' : 'fail', interventions: 0, retries: 0 },
        evidence: [
          { ref: input, digest: contentDigest(task.input) },
          { ref: artifact, digest: contentDigest(stream.finalOutput as string) },
          { ref: trace, digest: contentDigest(traceBytes) },
        ],
      };
      return appendEvent(ledger, record);
    }
    await work('observed-a', 'work', tasks[0], 'setup\nsetup');
    await work('observed-b', 'work', tasks[1], 'usage\nusage');
    await stage(candidateBody, 'v2');
    await mainRun('capture-candidate', 'captured');
    const candidate = activation!.snapshot;
    await appendEvent(ledger, {
      type: 'propose',
      id: 'runtime-candidate',
      candidate,
      weakness: 'Two actual model fixture outputs had duplicate anchors.',
      hypothesis: 'Duplicate suffix instructions produce expected fixture output.',
      mutation: 'Add duplicate suffix instruction.',
      evidenceRunIds: ['observed-a', 'observed-b'],
    });
    for (const task of tasks) {
      await stage(originalBody, 'v1');
      await work(
        `${task.id}-base`,
        'benchmark',
        task,
        `${task.id === 'a' ? 'setup' : task.id === 'b' ? 'usage' : 'build'}\n${
          task.id === 'a' ? 'setup' : task.id === 'b' ? 'usage' : 'build'
        }`,
      );
      await stage(candidateBody, 'v2');
      await work(`${task.id}-candidate`, 'benchmark', task, task.expected);
    }
    await stage(originalBody, 'v1');
    const stateBeforeReview = await readLedger(ledger);
    await mainRun('request-review', 'review completed', delegate, {
      execution: 'foreground',
      role: 'reviewer',
      task: `Independently compare retained artifact pairs at ${root}; frozen criteria ${stateBeforeReview.criteriaId}.`,
    });
    expect(reviewResult?.status).toBe('completed');
    expect(reviewResult?.toolsUsed).toEqual([{ toolName: 'run_explorer', count: 1 }]);
    expect(explorerTasks).toHaveLength(1);
    expect(reviewerRequests).toHaveLength(2);
    expect(reviewerRequests[0].input.every((item) => item.type !== 'tool_result')).toBe(true);
    const report = join(root, 'reviewer-result.json');
    const reportBytes = JSON.stringify(reviewResult);
    await writeFile(report, reportBytes);
    const returned = JSON.parse(reviewResult!.finalText) as { pairs: Review['pairs'] };
    const review: Review = {
      type: 'compare',
      id: 'runtime-review',
      criteriaId: stateBeforeReview.criteriaId,
      reviewer: { role: 'reviewer', sessionId: reviewResult!.agentId },
      pairs: returned.pairs.map((pair) => ({
        ...pair,
        evidence: [...pair.evidence, { ref: report, digest: contentDigest(reportBytes) }],
      })),
    };
    expect((await appendEvent(ledger, review)).decision?.verdict).toBe('keep');

    let installations = 0;
    const install: ToolDefinition = {
      name: 'fixture_install_method',
      description: 'Authorized local fixture installation boundary.',
      parameters: z.object({}),
      needsApproval: () => true,
      formatCommandMessage: () => [],
      execute: async (_args, context, details) => {
        const callId = (details as { toolCall: { callId: string } }).toolCall.callId;
        const approvals = (context as ToolInvocationContext).approvals;
        expect(approvals.isToolApproved({ toolName: 'fixture_install_method', callId })).toBe(true);
        const approvalPath = join(root, 'runtime-approval.json');
        await writeFile(approvalPath, JSON.stringify({ callId, approvals: approvals.snapshot() }));
        await appendEvent(ledger, {
          type: 'promote',
          id: 'runtime-promotion',
          approval: { ref: approvalPath, candidateId: digest(candidate), reviewId: review.id },
        });
        await copyFile(candidatePath, skillPath);
        revision = 'v2';
        installations++;
        return 'Local fixture method installed; explicit host reload still required.';
      },
    };
    const denied = await mainRun('denied-install', 'denied', install, {});
    expect(denied.stream.interruptions).toHaveLength(1);
    denied.stream.state!.reject!(denied.stream.interruptions![0], { message: 'Fixture operator declines this call.' });
    await denied.loop.continueRunStream(denied.stream.state!).completed;
    expect(installations).toBe(0);
    expect((await readLedger(ledger)).activeMethodId).toBe(digest(incumbent));
    expect(await readFile(skillPath, 'utf8')).toBe(skillFile(originalBody));
    const paused = await mainRun('install', 'installed', install, {});
    expect(paused.stream.interruptions).toHaveLength(1);
    expect(installations).toBe(0);
    expect((await readLedger(ledger)).activeMethodId).toBe(digest(incumbent));
    expect(await readFile(skillPath, 'utf8')).toBe(skillFile(originalBody));
    paused.stream.state!.approve!(paused.stream.interruptions![0]);
    await paused.loop.continueRunStream(paused.stream.state!).completed;
    expect(installations).toBe(1);
    await expect(work('stale-work', 'work', tasks[0], tasks[0].expected)).rejects.toThrow(
      'Loaded method identity mismatch',
    );
    expect(activation!.snapshot.body).toBe(originalBody);
    expect((await readLedger(ledger)).adoption).toBeUndefined();
    // Existing host rediscovery, equivalent to restarting with a fresh skill cache.
    skills.discoverSkills();
    const next = await work(
      'subsequent-work',
      'work',
      { id: 'next', input: '## Next\n## Next', expected: 'next\nnext-1' },
      'next\nnext-1',
    );
    expect(next.runs['subsequent-work'].loadedMethod).toEqual(candidate);
    expect(next.adoption).toEqual({
      promotionId: 'runtime-promotion',
      runId: 'subsequent-work',
      methodId: digest(candidate),
    });
    expect([...mainRequests].reverse().find((request) => resultText(request, 'activate_skill'))?.input).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'tool_result', id: 'subsequent-work-call' })]),
    );
    expect(resultText(mainRequests[mainRequests.length - 1], 'activate_skill')).toContain(candidateBody);
    for (const evidence of [
      ...Object.values(next.runs).flatMap((run) => run.evidence),
      ...next.review!.pairs.flatMap((pair) => pair.evidence),
    ]) {
      expect(contentDigest(await readFile(evidence.ref))).toBe(evidence.digest);
    }
    const approvalReceipt = JSON.parse(await readFile(next.promotion!.approval.ref, 'utf8'));
    expect(approvalReceipt.callId).toBe('install-call');
    expect(approvalReceipt.approvals.fixture_install_method.approved).toEqual(['install-call']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
