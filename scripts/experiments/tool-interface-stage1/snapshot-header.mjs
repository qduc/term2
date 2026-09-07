import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { headerSnapshotFromDescription, compareNameSets } from './lib/header.mjs';

function stubAsync(result) {
  return async () => result;
}

export async function snapshotRunCodeHeader(distRoot, { settingsDir, model, providerId, projectRoot } = {}) {
  const dist = path.resolve(distRoot);
  const moduleAt = (relativePath) => import(pathToFileURL(path.join(dist, relativePath)).href);
  await moduleAt('providers/index.js');
  const [
    { getAgentDefinition },
    { buildAgentTools },
    { LoggingService },
    { SettingsService, buildEnvOverrides },
    { ExecutionContext },
    { ToolApprovalPolicyRegistry },
    { createEditorImpl },
    { SkillsService },
    { RUN_CODE_PROHIBITED_TOOLS },
    { shouldUseNativePatchTool },
  ] = await Promise.all([
    moduleAt('agent.js'),
    moduleAt('lib/agent-factory.js'),
    moduleAt('services/logging/logging-service.js'),
    moduleAt('services/settings/settings-service.js'),
    moduleAt('services/execution-context.js'),
    moduleAt('services/approval/tool-approval-policy-registry.js'),
    moduleAt('lib/editor-impl.js'),
    moduleAt('services/skills/skills-service.js'),
    moduleAt('tools/system/run-code/index.js'),
    moduleAt('lib/tool-selection-policy.js'),
  ]);
  const logger = new LoggingService({ disableLogging: true, suppressConsoleOutput: true });
  const settings = new SettingsService({
    settingsDir,
    env: buildEnvOverrides(),
    loggingService: logger,
    disableFilePersistence: true,
  });
  const executionContext = new ExecutionContext();
  const root = projectRoot || process.cwd();
  const skillsService = new SkillsService(logger, root);
  skillsService.discoverSkills(root);
  const resolvedModel = model || settings.get('agent.model');
  const resolvedProvider = providerId || settings.get('agent.provider');
  const factoryDeps = {
    settings,
    logger,
    executionContext,
    editor: createEditorImpl(settings, logger, executionContext),
    providerId: resolvedProvider,
    serviceTierOverrideForNextRequest: null,
    createMentor: stubAsync(''),
    runSubagent: stubAsync({ finalText: '' }),
    runSubagentAsync: stubAsync({ runId: 'snapshot' }),
    getSubagentResult: stubAsync({}),
    getSubagentStatus: () => ({}),
    sendSubagentMessage: () => ({}),
    cancelSubagentRun: () => ({}),
    checkToolInterceptors: stubAsync(null),
    skillsService,
    approvalPolicyRegistry: new ToolApprovalPolicyRegistry(),
    allowBackgroundShell: false,
    allowAskUser: false,
  };
  const definition = getAgentDefinition(
    {
      settingsService: settings,
      loggingService: logger,
      executionContext,
      approvalPolicyRegistry: factoryDeps.approvalPolicyRegistry,
      runSubagent: factoryDeps.runSubagent,
      runSubagentAsync: factoryDeps.runSubagentAsync,
      getSubagentResult: factoryDeps.getSubagentResult,
      getSubagentStatus: factoryDeps.getSubagentStatus,
      sendSubagentMessage: factoryDeps.sendSubagentMessage,
      cancelSubagentRun: factoryDeps.cancelSubagentRun,
      skillsService,
      allowBackgroundShell: false,
      allowAskUser: false,
    },
    resolvedModel,
  );
  const boundTools = buildAgentTools({
    toolDefinitions: definition.tools,
    resolvedModel,
    shouldUseNativePatchTool: shouldUseNativePatchTool({
      providerId: resolvedProvider,
      model: resolvedModel,
    }),
    deps: factoryDeps,
  });
  const runCode = boundTools.find((tool) => tool.name === 'run_code');
  if (!runCode || typeof runCode.description !== 'string') {
    throw new Error('factory-bound graph is missing a run_code description');
  }
  const snapshot = headerSnapshotFromDescription(runCode.description, {
    distRoot: dist,
    mode: 'non-interactive-factory-bind',
    model: resolvedModel,
    providerId: resolvedProvider,
  });
  const scriptableNames = definition.tools
    .filter((tool) => !RUN_CODE_PROHIBITED_TOOLS.has(tool.name))
    .map((tool) => tool.name);
  const interactiveDef = getAgentDefinition(
    {
      settingsService: settings,
      loggingService: logger,
      executionContext,
      approvalPolicyRegistry: new ToolApprovalPolicyRegistry(),
      skillsService,
      allowBackgroundShell: true,
      allowAskUser: true,
      sessionBrowser: { list() { return []; } },
    },
    resolvedModel,
  );
  if (!snapshot.headerFound || snapshot.toolNameCount < 8) {
    throw new Error(
      'factory-bound run_code header is empty or stub-sized: headerFound=' +
        String(snapshot.headerFound) +
        ' toolNameCount=' +
        String(snapshot.toolNameCount),
    );
  }
  if (!compareNameSets(snapshot.toolNames, scriptableNames)) {
    throw new Error(
      'factory-bound header names do not match scriptable registry: header=' +
        snapshot.toolNames.join(',') +
        ' scriptable=' +
        scriptableNames.join(','),
    );
  }
  return {
    ...snapshot,
    scriptableNames,
    agentToolNames: definition.tools.map((tool) => tool.name),
    agentToolCount: definition.tools.length,
    modelFacingToolNames: boundTools.map((tool) => tool.name),
    interactiveToolNames: interactiveDef.tools.map((tool) => tool.name),
    interactiveToolCount: interactiveDef.tools.length,
    interactiveMinusNonInteractive: interactiveDef.tools
      .map((tool) => tool.name)
      .filter((name) => !definition.tools.some((tool) => tool.name === name)),
    hasRunCode: definition.tools.some((tool) => tool.name === 'run_code'),
    coverageNote:
      'Header bytes are the non-interactive CLI surface and understate interactive production (session tools absent). Interactive-max figures from replica fixtures are not acceptance evidence.',
  };
}
