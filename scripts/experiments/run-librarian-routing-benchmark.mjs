#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const [distRootArg, taskPath] = process.argv.slice(2);
if (!distRootArg || !taskPath) {
  console.error('Usage: run-librarian-routing-benchmark.mjs <dist-root> <task-file>');
  process.exit(2);
}

const distRoot = path.resolve(distRootArg);
const moduleAt = (relativePath) => import(pathToFileURL(path.join(distRoot, relativePath)).href);
const BENCHMARK_MODEL = 'openai/gpt-5.4-mini';
const BENCHMARK_PROVIDER = 'openrouter';

await moduleAt('providers/index.js');

const [
  { AgentClient },
  { getAgentDefinition },
  { LoggingService },
  { SettingsService, buildEnvOverrides },
  { SessionContextService },
  { createSessionRuntime },
] = await Promise.all([
  moduleAt('lib/agent-client.js'),
  moduleAt('agent.js'),
  moduleAt('services/logging/logging-service.js'),
  moduleAt('services/settings/settings-service.js'),
  moduleAt('services/session/session-context-service.js'),
  moduleAt('core/index.js'),
]);
const [{ ExecutionContext }, { ToolOwnershipRegistry }, { createSubagentRuntime }, { loadRoleDefinition }] =
  await Promise.all([
    moduleAt('services/execution-context.js'),
    moduleAt('services/approval/tool-ownership-registry.js'),
    moduleAt('services/subagents/runtime.js'),
    moduleAt('services/subagents/role-loader.js'),
  ]);

const sessionContextService = new SessionContextService();
const logger = new LoggingService({ sessionContextService, suppressConsoleOutput: true });
const settings = new SettingsService({
  env: buildEnvOverrides(),
  cli: {
    agent: {
      model: BENCHMARK_MODEL,
      provider: BENCHMARK_PROVIDER,
      reasoningEffort: 'medium',
      cheapModel: BENCHMARK_MODEL,
      cheapProvider: BENCHMARK_PROVIDER,
      cheapReasoningEffort: 'medium',
    },
    app: {
      liteMode: false,
      planMode: false,
      mentorMode: false,
      orchestratorMode: false,
    },
  },
  loggingService: logger,
});
const executionContext = new ExecutionContext();
const toolOwnership = new ToolOwnershipRegistry();
const clientDeps = { logger, settings, executionContext, sessionContextService };
const subagentRuns = [];

const subagents = createSubagentRuntime({
  logger,
  settings,
  sessionContextService,
  executionContext,
  toolOwnership,
  createClient: ({ agent, provider, maxTurns, retryAttempts }) =>
    new AgentClient({
      model: agent.model,
      maxTurns,
      retryAttempts,
      deps: clientDeps,
      agentOverride: agent,
      providerOverride: provider,
      toolOwnership,
      allowBackgroundShell: false,
      allowAskUser: false,
      wrapUpOnCriticalRunBudget: true,
    }),
});

const runSubagent = async (params) => {
  const definition = loadRoleDefinition(params.role, settings);
  const result = await subagents.executionRunner.run(randomUUID(), params, definition);
  subagentRuns.push(result);
  return result;
};

const rootAgent = getAgentDefinition(
  {
    settingsService: settings,
    loggingService: logger,
    executionContext,
    runSubagent,
    allowBackgroundShell: false,
    allowAskUser: false,
  },
  BENCHMARK_MODEL,
);
const rootClient = new AgentClient({
  model: rootAgent.model,
  maxTurns: 30,
  deps: clientDeps,
  agentOverride: rootAgent,
  providerOverride: BENCHMARK_PROVIDER,
  toolOwnership,
  allowBackgroundShell: false,
  allowAskUser: false,
});
const runtime = createSessionRuntime({
  sessionId: `librarian-routing-benchmark-${process.pid}`,
  agentClient: rootClient,
  toolOwnership,
  deps: { logger, settingsService: settings, sessionContextService },
  retryOptions: { allowFreshStartRetries: false },
});

const task = await fs.readFile(path.resolve(taskPath), 'utf8');
const rootTools = [];
let finalText = '';
let usage;
for await (const event of runtime.turns.start({ text: task, images: [] })) {
  if (event.type === 'tool_started') rootTools.push(event.toolName);
  if (event.type === 'final') {
    finalText = event.finalText;
    usage = event.usage;
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      status: 'completed',
      finalText,
      usage,
      rootTools,
      subagentRuns: subagentRuns.map(({ role, status, finalText: text, toolsUsed, usage: childUsage }) => ({
        role,
        status,
        finalText: text,
        toolsUsed,
        usage: childUsage,
      })),
    },
    null,
    2,
  )}\n`,
);
