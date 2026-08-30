#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [distRootArg, taskPath] = process.argv.slice(2);
if (!distRootArg || !taskPath) {
  console.error('Usage: run-librarian-benchmark.mjs <dist-root> <task-file>');
  process.exit(2);
}

const distRoot = path.resolve(distRootArg);
const moduleAt = (relativePath) => import(pathToFileURL(path.join(distRoot, relativePath)).href);

await moduleAt('providers/index.js');

const [{ AgentClient }, { LoggingService }, { SettingsService, buildEnvOverrides }, { SessionContextService }] =
  await Promise.all([
    moduleAt('lib/agent-client.js'),
    moduleAt('services/logging/logging-service.js'),
    moduleAt('services/settings/settings-service.js'),
    moduleAt('services/session/session-context-service.js'),
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
      model: 'gpt-5.6-luna',
      provider: 'codex',
      reasoningEffort: 'medium',
      cheapModel: 'gpt-5.6-luna',
      cheapProvider: 'codex',
      cheapReasoningEffort: 'medium',
    },
  },
  loggingService: logger,
});
const executionContext = new ExecutionContext();
const toolOwnership = new ToolOwnershipRegistry();
const clientDeps = { logger, settings, executionContext, sessionContextService };

const runtime = createSubagentRuntime({
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

const task = await fs.readFile(path.resolve(taskPath), 'utf8');
const definition = loadRoleDefinition('librarian', settings);
const result = await runtime.executionRunner.run(
  `librarian-benchmark-${process.pid}`,
  { role: 'librarian', task },
  definition,
);

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exitCode = result.status === 'completed' ? 0 : 1;
