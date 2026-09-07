import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { headerSnapshotFromDescription } from './lib/header.mjs';

export async function snapshotRunCodeHeader(distRoot, { settingsDir } = {}) {
  const dist = path.resolve(distRoot);
  const moduleAt = (relativePath) => import(pathToFileURL(path.join(dist, relativePath)).href);
  await moduleAt('providers/index.js');
  const [
    { getAgentDefinition },
    { LoggingService },
    { SettingsService, buildEnvOverrides },
    { ExecutionContext },
  ] = await Promise.all([
    moduleAt('agent.js'),
    moduleAt('services/logging/logging-service.js'),
    moduleAt('services/settings/settings-service.js'),
    moduleAt('services/execution-context.js'),
  ]);
  const logger = new LoggingService({ disableLogging: true, suppressConsoleOutput: true });
  const settings = new SettingsService({
    settingsDir: settingsDir,
    env: buildEnvOverrides(),
    loggingService: logger,
    disableFilePersistence: true,
  });
  const executionContext = new ExecutionContext();
  const nonInteractive = getAgentDefinition(
    {
      settingsService: settings,
      loggingService: logger,
      executionContext,
      allowBackgroundShell: false,
      allowAskUser: false,
    },
    settings.get('agent.model'),
  );
  const interactive = getAgentDefinition(
    {
      settingsService: settings,
      loggingService: logger,
      executionContext,
      allowBackgroundShell: true,
      allowAskUser: true,
      sessionBrowser: { list() { return []; } },
    },
    settings.get('agent.model'),
  );
  const runCode = nonInteractive.tools.find((tool) => tool.name === 'run_code');
  if (!runCode || typeof runCode.description !== 'string') {
    throw new Error('non-interactive agent is missing a run_code description');
  }
  const snapshot = headerSnapshotFromDescription(runCode.description, {
    distRoot: dist,
    mode: 'non-interactive-construction',
  });
  const interactiveNames = interactive.tools.map((tool) => tool.name);
  const nonInteractiveNames = nonInteractive.tools.map((tool) => tool.name);
  return {
    ...snapshot,
    agentToolNames: nonInteractiveNames,
    agentToolCount: nonInteractiveNames.length,
    interactiveToolNames: interactiveNames,
    interactiveToolCount: interactiveNames.length,
    interactiveMinusNonInteractive: interactiveNames.filter((name) => !nonInteractiveNames.includes(name)),
    hasRunCode: nonInteractiveNames.includes('run_code'),
    note: 'Construction-path snapshot of the production registry. Name lists used for pair fairness come from this header, not a hand-authored catalog. Interactive count is reported only as the O1 stub-vs-production check; the driver uses the non-interactive CLI surface.',
  };
}
