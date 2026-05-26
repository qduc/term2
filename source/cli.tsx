#!/usr/bin/env node
import './env-setup.js';
import React from 'react';
import type { ReactNode } from 'react';
import { render } from 'ink';
import meow from 'meow';
import App from './app.js';
import { SSHInfo } from './hooks/use-shell-mode.js';
import { getInkRenderOptions } from './utils/ink-render-options.js';
import { OpenAIAgentClient } from './lib/openai-agent-client.js';
import { ConversationService } from './services/conversation-service.js';
import { SettingsService, buildEnvOverrides } from './services/settings-service.js';
import { getAllProviders, getProviderIds } from './providers/index.js';
import { LoggingService } from './services/logging-service.js';
import { HistoryService } from './services/history-service.js';
import { SSHService, SSHConfig } from './services/ssh-service.js';
import { ExecutionContext } from './services/execution-context.js';
import { ISSHService } from './services/service-interfaces.js';
import { resolveSSHHost } from './utils/ssh-config-parser.js';
import { createUsageAccumulator, formatSessionUsageBreakdown } from './utils/token-usage.js';
import {
  generateId,
  getResumeCommand,
  loadConversationForProject,
  loadLastConversation,
  forkConversation,
  isConversationLocked,
  type RestoredState,
} from './services/conversation-persistence.js';
import { createConversationLogWriter, LockConflictError } from './services/conversation-log-writer.js';
import { AGENT_AFFECTING_SETTINGS } from './services/conversation-log-events.js';
import { installPlanModeInterceptor } from './services/plan-mode-interceptor.js';
import { normalizeAppModes } from './services/settings-schema.js';
import os from 'os';
import fs from 'fs';
import path from 'path';
import type { Message } from './hooks/use-conversation.js';

const sessionUsageAccumulator = createUsageAccumulator();
const subagentUsageAccumulator = createUsageAccumulator();
let usagePrinted = false;
const printUsage = () => {
  process.stdout.write(
    `\n${formatSessionUsageBreakdown(sessionUsageAccumulator.get(), subagentUsageAccumulator.get())}\n`,
  );
};
const printUsageOnce = () => {
  if (usagePrinted) return;
  usagePrinted = true;
  printUsage();
};

type WriterHandle = ReturnType<typeof createConversationLogWriter> | null;
let activeLogWriter: WriterHandle = null;

// Global Ctrl+C handler for immediate exit paths outside Ink's input handling.
process.on('SIGINT', () => {
  void (activeLogWriter ? activeLogWriter.flush() : Promise.resolve()).finally(() => {
    printUsageOnce();
    process.exit(130);
  });
});

// Best-effort release of lock + close on uncatchable exits (caught process.exit).
process.on('exit', () => {
  if (activeLogWriter) {
    try {
      // Synchronous close path: the writer's close() does sync work and unlinks the lock.
      void activeLogWriter.close();
    } catch {
      /* ignore */
    }
  }
});

const cli = meow(
  `
        Usage
          $ term2

                    $ term2 "prompt here"

        Options
          -m, --model       Override the default OpenAI model (e.g. gpt-4o)
          -r, --reasoning   Set the reasoning effort for reasoning models (e.g. medium, high)
          -p, --provider    Override the default provider (e.g. openai, openrouter)
          -l, --lite        Start in lite mode (minimal context, session-only)
                    --auto-approve    Allow tool execution in non-interactive mode
          --ssh             Enable SSH mode (user@host)
          --remote-dir      Required remote working directory for SSH mode
          --ssh-port        Optional SSH port (default: 22)
          -R, --resume      Resume a conversation (optionally provide UUID)

        Examples
          $ term2 -m gpt-4o
          $ term2 --lite
                    $ term2 "explain this function"
                    $ term2 --auto-approve "list files in current dir"
          $ term2 --resume          # Resume last conversation
          $ term2 --resume <uuid>   # Resume specific conversation
    `,
  {
    importMeta: import.meta,
    flags: {
      model: {
        type: 'string',
        alias: 'm',
      },
      provider: {
        type: 'string',
        alias: 'p',
      },
      reasoning: {
        type: 'string',
        alias: 'r',
      },
      lite: {
        type: 'boolean',
        alias: 'l',
        default: false,
      },
      autoApprove: {
        type: 'boolean',
        default: false,
      },
      ssh: {
        type: 'string',
      },
      remoteDir: {
        type: 'string',
      },
      sshPort: {
        type: 'number',
        default: 22,
      },
      resume: {
        type: 'boolean',
        alias: 'R',
        default: false,
      },
      fork: {
        type: 'boolean',
        default: false,
      },
    },
  },
);

const resumeRequested = Boolean(cli.flags.resume);
const forkRequested = Boolean(cli.flags.fork);
const resumeTarget = resumeRequested ? cli.input[0]?.trim() : undefined;

if (resumeRequested && cli.input.length > 1) {
  console.error('Error: --resume accepts at most one conversation id.');
  process.exit(1);
}

if (forkRequested && !resumeRequested) {
  console.error('Error: --fork can only be used with --resume.');
  process.exit(1);
}

const positionalPrompt = resumeRequested ? '' : cli.input.join(' ').trim();
const hasPositionalPrompt = positionalPrompt.length > 0;

// If the user passed an explicit empty prompt (e.g. `term2 ""`), show help.
if (!resumeRequested && cli.input.length > 0 && !hasPositionalPrompt) {
  cli.showHelp(0);
}

const rawModelFlag = cli.flags.model;
const rawProviderFlag = cli.flags.provider;
const rawReasoningFlag = cli.flags.reasoning;

const modelFlag = typeof rawModelFlag === 'string' && rawModelFlag.trim().length > 0 ? rawModelFlag.trim() : undefined;
const providerFlag =
  typeof rawProviderFlag === 'string' && rawProviderFlag.trim().length > 0 ? rawProviderFlag.trim() : undefined;
const reasoningEffort =
  typeof rawReasoningFlag === 'string' && rawReasoningFlag.trim().length > 0 ? rawReasoningFlag.trim() : undefined;

// Validate provider flag against available providers
const validProviderIds = getProviderIds();
const validatedProviderFlag: string | undefined =
  providerFlag && validProviderIds.includes(providerFlag) ? providerFlag : undefined;

if (providerFlag && !validatedProviderFlag) {
  console.error(`Error: Unknown provider "${providerFlag}".`);
  console.error('Available providers:');
  const providers = getAllProviders();
  for (const p of providers) {
    console.error(`  - ${p.id}  (${p.label})`);
  }
  console.error('\nYou can configure custom providers in your settings.json file.');
  process.exit(1);
}

const validReasoningEfforts = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', null] as const;
type ModelSettingsReasoningEffort = (typeof validReasoningEfforts)[number];

const validatedReasoningEffort: ModelSettingsReasoningEffort | undefined =
  reasoningEffort && validReasoningEfforts.includes(reasoningEffort as any)
    ? (reasoningEffort as ModelSettingsReasoningEffort)
    : undefined;

const resumeProjectPath = cli.flags.ssh ? cli.flags.remoteDir?.trim() || undefined : process.cwd();
const expectedSshHost = cli.flags.ssh
  ? cli.flags.ssh.includes('@')
    ? cli.flags.ssh.split('@')[1]
    : cli.flags.ssh
  : undefined;
let resumedConversation: RestoredState | null = null;
let resumedSourceId: string | undefined;
if (resumeRequested) {
  if (resumeTarget) {
    const result = resumeProjectPath
      ? loadConversationForProject(resumeTarget, resumeProjectPath, expectedSshHost)
      : { status: 'not_found' as const };
    if (result.status === 'project_mismatch') {
      console.error(
        `Error: Conversation ${resumeTarget} belongs to a different project path (${
          result.conversation.projectPath ?? 'unknown'
        }).`,
      );
      console.error(`Current project path: ${resumeProjectPath ?? 'unknown'}`);
      if (result.conversation.sshHost || expectedSshHost) {
        console.error(`Conversation SSH Host: ${result.conversation.sshHost ?? 'none'}`);
        console.error(`Current SSH Host: ${expectedSshHost ?? 'none'}`);
      }
      process.exit(1);
    }
    resumedConversation = result.status === 'loaded' ? result.conversation : null;
    resumedSourceId = resumeTarget;
  } else {
    resumedConversation = loadLastConversation(resumeProjectPath, expectedSshHost);
    resumedSourceId = resumedConversation?.id;
  }
}

// If --fork was requested, copy the source jsonl to a new id and resume from the copy.
if (forkRequested) {
  if (!resumedSourceId || !resumedConversation) {
    console.error('Error: --fork requires an existing conversation to fork from.');
    process.exit(1);
  }
  const forkedId = generateId();
  if (!forkConversation(resumedSourceId, forkedId)) {
    console.error(`Error: Could not fork conversation ${resumedSourceId}.`);
    process.exit(1);
  }
  console.log(`Forked conversation ${resumedSourceId} → ${forkedId}`);
  resumedConversation = { ...resumedConversation, id: forkedId, forkedFrom: resumedSourceId };
  resumedSourceId = forkedId;
}

// Apply CLI overrides to settings service
const cliOverrides: any = {};

if (resumedConversation) {
  cliOverrides.agent = {};
  if (resumedConversation.model && !modelFlag) {
    cliOverrides.agent.model = resumedConversation.model;
  }
  if (resumedConversation.provider) {
    cliOverrides.agent.provider = resumedConversation.provider;
  }
  if (
    resumedConversation.reasoningEffort &&
    !validatedReasoningEffort &&
    validReasoningEfforts.includes(resumedConversation.reasoningEffort as any)
  ) {
    cliOverrides.agent.reasoningEffort = resumedConversation.reasoningEffort;
  }
  if (resumedConversation.appMode) {
    cliOverrides.app = {
      ...cliOverrides.app,
      mentorMode: resumedConversation.appMode.mentorMode,
      liteMode: resumedConversation.appMode.liteMode,
      planMode: resumedConversation.appMode.planMode,
      orchestratorMode: resumedConversation.appMode.orchestratorMode ?? false,
    };
  }
}

if (modelFlag) {
  cliOverrides.agent = { ...cliOverrides.agent, model: modelFlag };
}

if (validatedProviderFlag) {
  cliOverrides.agent = { ...cliOverrides.agent, provider: validatedProviderFlag };
}

if (validatedReasoningEffort) {
  cliOverrides.agent = {
    ...cliOverrides.agent,
    reasoningEffort: validatedReasoningEffort,
  };
}

// Create LoggingService instance
const logger = new LoggingService({
  disableLogging: false,
});

// Build settings with CLI overrides applied first so we can read persisted
// exclusive modes before deciding the implicit lite default.
const settings = new SettingsService({
  env: buildEnvOverrides(),
  cli: Object.keys(cliOverrides).length > 0 ? cliOverrides : undefined,
  loggingService: logger,
});

// Fresh sessions honor --lite/non-interactive defaults. Resumed sessions keep
// the saved mode profile so prompt/tool behavior matches the conversation.
// IMPORTANT: only apply the implicit lite default when no other exclusive mode
// is already active (orchestrator or mentor take precedence).
{
  let resolvedLiteMode: boolean;
  if (resumedConversation) {
    resolvedLiteMode = cliOverrides.app?.liteMode ?? false;
  } else if (cli.flags.lite) {
    resolvedLiteMode = true;
  } else {
    const implicitLite = Boolean(hasPositionalPrompt && !cli.flags.autoApprove);
    const persistedOrchestrator = settings.get<boolean>('app.orchestratorMode');
    const persistedMentor = settings.get<boolean>('app.mentorMode');
    // Implicit lite must not override a higher-precedence mode already persisted.
    resolvedLiteMode = implicitLite && !persistedOrchestrator && !persistedMentor;
  }
  settings.set('app.liteMode', resolvedLiteMode, { persist: false });
}

// Normalize all mode flags to enforce mutual exclusion with a consistent
// precedence: orchestratorMode > liteMode > planMode > mentorMode.
const normalized = normalizeAppModes({
  orchestratorMode: settings.get<boolean>('app.orchestratorMode'),
  liteMode: settings.get<boolean>('app.liteMode'),
  planMode: settings.get<boolean>('app.planMode'),
  mentorMode: settings.get<boolean>('app.mentorMode'),
});
settings.set('app.orchestratorMode', normalized.orchestratorMode, { persist: false });
settings.set('app.liteMode', normalized.liteMode, { persist: false });
settings.set('app.planMode', normalized.planMode, { persist: false });
settings.set('app.mentorMode', normalized.mentorMode, { persist: false });

// SSH Handling
const sshFlag = cli.flags.ssh;
const remoteDirFlag = cli.flags.remoteDir;
const sshPortFlag = cli.flags.sshPort;

let sshService: ISSHService | undefined;
let executionContext: ExecutionContext | undefined;
let sshInfo: SSHInfo | undefined;

if (sshFlag) {
  if (!remoteDirFlag && !cli.flags.lite) {
    console.error('Error: --remote-dir is required when using --ssh');
    process.exit(1);
  }

  let user = '';
  let host = sshFlag;
  if (sshFlag.includes('@')) {
    [user, host] = sshFlag.split('@');
  }

  // Try to resolve host from ~/.ssh/config
  const sshConfigPath = path.join(os.homedir(), '.ssh', 'config');
  let resolvedHost = host;
  let resolvedUser = user;
  let resolvedPort = sshPortFlag || 22;
  let identityFile: string | undefined;

  if (fs.existsSync(sshConfigPath)) {
    try {
      const configContent = fs.readFileSync(sshConfigPath, 'utf-8');
      const hostConfig = resolveSSHHost(host, configContent);
      if (hostConfig) {
        resolvedHost = hostConfig.hostName || host;
        resolvedUser = user || hostConfig.user || '';
        resolvedPort = sshPortFlag !== 22 ? sshPortFlag : hostConfig.port || 22;
        identityFile = hostConfig.identityFile;
      }
    } catch {
      // Ignore errors reading SSH config, fall back to direct host
    }
  }

  const sshConfig: SSHConfig = {
    host: resolvedHost,
    port: resolvedPort,
    username: resolvedUser || os.userInfo().username,
    agent: process.env.SSH_AUTH_SOCK,
    identityFile,
  };

  const service = new SSHService(sshConfig);

  // Initialize remoteDir with the flag value
  let remoteDir = remoteDirFlag;

  try {
    // We use top-level await here assuming node16+ / esm
    // To provide feedback, we can log to console before UI starts
    console.log(`Connecting to ${host}...`);
    await service.connect();
    sshService = service;

    // If remoteDir was not specified (only allowed in lite mode), auto-detect it
    if (!remoteDir) {
      try {
        const { stdout } = await service.executeCommand('pwd');
        remoteDir = stdout.trim();
        console.log(`Defaulting to remote directory: ${remoteDir}`);
      } catch (e: any) {
        console.warn('Failed to detect remote home directory, defaulting to "."', e.message);
        remoteDir = '.';
      }
    }

    // Create SSH info for status bar display
    sshInfo = {
      host: host, // Use original alias for display
      user: sshConfig.username,
      remoteDir: remoteDir,
    };

    // Setup cleanup
    const cleanup = () => {
      if (sshService?.isConnected()) {
        sshService.disconnect();
      }
    };
    process.on('exit', cleanup);
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  } catch (e: any) {
    console.error(`Failed to connect via SSH to ${host}:`, e.message);
    process.exit(1);
  }

  executionContext = new ExecutionContext(sshService, remoteDir);
} else {
  executionContext = new ExecutionContext();
}

const history = new HistoryService({
  loggingService: logger,
  settingsService: settings,
});

const usedModel = settings.get('agent.model');
const usedReasoningEffort = settings.get('agent.reasoningEffort');

const agentClient = new OpenAIAgentClient({
  model: usedModel,
  reasoningEffort: usedReasoningEffort as ModelSettingsReasoningEffort,
  maxTurns: settings.get('agent.maxTurns'),
  retryAttempts: settings.get('agent.retryAttempts'),
  deps: {
    logger: logger,
    settings: settings,
    executionContext: executionContext,
  },
});

installPlanModeInterceptor(agentClient, { settingsService: settings });

if (hasPositionalPrompt) {
  const { runNonInteractive } = await import('./non-interactive.js');
  const exitCode = await runNonInteractive({
    prompt: positionalPrompt,
    autoApprove: cli.flags.autoApprove,
    agentClient,
    logger,
    settingsService: settings,
  });
  process.exit(exitCode);
}

// Generate session UUID and handle resume
let effectiveSessionId = generateId();
let effectiveCreatedAt = new Date().toISOString();
let initialMessages: Message[] = [];

if (resumedConversation) {
  effectiveSessionId = resumedConversation.id;
  effectiveCreatedAt = resumedConversation.createdAt;
  initialMessages = resumedConversation.messages as Message[];
  if (resumedConversation.usage) {
    sessionUsageAccumulator.add(resumedConversation.usage);
  }
  if (resumedConversation.subagentUsage) {
    subagentUsageAccumulator.add(resumedConversation.subagentUsage);
  }
} else if (resumeRequested) {
  const target = resumeTarget ?? 'last';
  console.warn(`No conversation found to resume (${target}). Starting new conversation.`);
}

// Refuse to open a session whose log file is locked by another writer (live or stale).
// --fork (handled above) is the documented escape hatch.
if (!forkRequested) {
  const lockInfo = isConversationLocked(effectiveSessionId);
  if (lockInfo) {
    const pid = lockInfo.pid;
    const host = lockInfo.host;
    const startedAt = lockInfo.startedAt;
    console.error(
      `Conversation ${effectiveSessionId} is locked (pid ${pid}, started ${startedAt}, host ${host}).\n` +
        `- If another terminal still has it open, close that one first.\n` +
        `- If a previous run crashed and left the lock behind, fork into a new\n` +
        `  conversation that branches from the same state:\n` +
        `      term2 --resume ${effectiveSessionId} --fork\n`,
    );
    process.exit(1);
  }
}

const conversationService = new ConversationService({
  agentClient,
  sessionId: effectiveSessionId,
  deps: {
    logger: logger,
    settingsService: settings,
  },
});

if (resumedConversation) {
  const savedProviderMatches =
    !resumedConversation.provider || resumedConversation.provider === settings.get('agent.provider');
  const savedModelMatches = !resumedConversation.model || resumedConversation.model === settings.get('agent.model');
  const previousResponseId = savedProviderMatches && savedModelMatches ? resumedConversation.previousResponseId : null;

  conversationService.importState({
    history: resumedConversation.history,
    previousResponseId,
    toolLedger: resumedConversation.toolLedger,
    updatedAt: resumedConversation.updatedAt,
  });
  for (const warning of resumedConversation.replayWarnings) {
    console.warn(`Conversation replay: ${warning}`);
  }
  console.log(`Resumed conversation: ${resumedConversation.id}`);
}

// Open the append-only log writer for the active session.
import envPaths from 'env-paths';
const logWriterDir = path.join(envPaths('term2').log, 'conversations');
const logWriter = createConversationLogWriter({ sessionId: effectiveSessionId, dir: logWriterDir, logger });
function buildInitMeta(id: string, createdAt: string) {
  const cwd = executionContext?.getCwd();
  return {
    id,
    createdAt,
    ...(cwd ? { projectPath: cwd } : {}),
    ...(sshInfo?.host ? { sshHost: sshInfo.host } : {}),
    appMode: {
      mentorMode: settings.get<boolean>('app.mentorMode') ?? false,
      liteMode: settings.get<boolean>('app.liteMode') ?? false,
      planMode: settings.get<boolean>('app.planMode') ?? false,
      orchestratorMode: settings.get<boolean>('app.orchestratorMode') ?? false,
    },
    ...(settings.get<string>('agent.model') ? { model: settings.get<string>('agent.model') } : {}),
    ...(settings.get<string>('agent.provider') ? { provider: settings.get<string>('agent.provider') } : {}),
    ...(settings.get<string>('agent.reasoningEffort')
      ? { reasoningEffort: settings.get<string>('agent.reasoningEffort') }
      : {}),
    ...(resumedConversation?.forkedFrom ? { forkedFrom: resumedConversation.forkedFrom } : {}),
  };
}
try {
  logWriter.init(buildInitMeta(effectiveSessionId, effectiveCreatedAt));
} catch (err) {
  if (err instanceof LockConflictError) {
    const info = err.lockInfo;
    console.error(
      `Conversation ${effectiveSessionId} is locked (pid ${info?.pid}, started ${info?.startedAt}, host ${info?.host}).\n` +
        `- If another terminal still has it open, close that one first.\n` +
        `- If a previous run crashed and left the lock behind, fork into a new\n` +
        `  conversation that branches from the same state:\n` +
        `      term2 --resume ${effectiveSessionId} --fork\n`,
    );
    process.exit(1);
  }
  throw err;
}
activeLogWriter = logWriter;
conversationService.setLogSink((event) => logWriter.append(event));

// Persist agent-affecting settings changes as they happen.
settings.onChange((key) => {
  if (!key || !AGENT_AFFECTING_SETTINGS.has(key)) return;
  logWriter.append({ type: 'settings_changed', key, value: settings.get(key) });
});

import { InputProvider } from './context/InputContext.js';
import { patchStdoutForSynchronizedOutput } from './utils/synchronized-output.js';

// Enable DEC Mode 2026 synchronized output to prevent flickering in iTerm2.
// This wraps every stdout.write() in begin/end markers so the terminal
// buffers the entire Ink render frame and paints it atomically.
patchStdoutForSynchronizedOutput(process.stdout);

const { waitUntilExit } = render(
  (
    <InputProvider>
      <App
        conversationService={conversationService}
        settingsService={settings}
        historyService={history}
        loggingService={logger}
        sshInfo={sshInfo}
        sshService={sshService}
        usageAccumulator={sessionUsageAccumulator}
        subagentUsageAccumulator={subagentUsageAccumulator}
        onPrintUsage={printUsage}
        onExitUsage={printUsageOnce}
        sessionId={effectiveSessionId}
        initialMessages={initialMessages}
        logWriter={logWriter}
        onRotateWriter={(newId) => {
          logWriter.append({ type: 'session_cleared' });
          logWriter.rotate(newId, buildInitMeta(newId, new Date().toISOString()));
        }}
        generateId={generateId}
        onSessionIdChange={(newId, createdAt) => {
          effectiveSessionId = newId;
          effectiveCreatedAt = createdAt;
        }}
      />
    </InputProvider>
  ) as ReactNode,
  getInkRenderOptions(),
);

await waitUntilExit();
await logWriter.close();
activeLogWriter = null;
const resumeCmd = getResumeCommand(effectiveSessionId, sshFlag, sshInfo?.remoteDir, cli.flags.sshPort);
printUsageOnce();
console.log(`\nTo resume this conversation: ${resumeCmd}`);
process.exit(0);
