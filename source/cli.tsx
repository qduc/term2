#!/usr/bin/env node
import React from 'react';
import type {ReactNode} from 'react';
import {render} from 'ink';
import meow from 'meow';
import App, {SSHInfo} from './app.js';
import {getInkRenderOptions} from './utils/ink-render-options.js';
import {OpenAIAgentClient} from './lib/openai-agent-client.js';
import {ConversationService} from './services/conversation-service.js';
import {
    SettingsService,
    buildEnvOverrides,
} from './services/settings-service.js';
import {LoggingService} from './services/logging-service.js';
import {HistoryService} from './services/history-service.js';
import { SSHService, SSHConfig } from './services/ssh-service.js';
import { ExecutionContext } from './services/execution-context.js';
import { ISSHService } from './services/service-interfaces.js';
import { resolveSSHHost } from './utils/ssh-config-parser.js';
import os from 'os';
import fs from 'fs';
import path from 'path';

// Global Ctrl+C handler for immediate exit
process.on('SIGINT', () => {
    process.exit(0);
});

const cli = meow(
    `
        Usage
          $ term2

        Options
          -m, --model       Override the default OpenAI model (e.g. gpt-4o)
          -r, --reasoning   Set the reasoning effort for reasoning models (e.g. medium, high)
          -l, --lite        Start in lite mode (minimal context, session-only)
          --ssh             Enable SSH mode (user@host)
          --remote-dir      Required remote working directory for SSH mode
          --ssh-port        Optional SSH port (default: 22)

        Examples
          $ term2 -m gpt-4o
          $ term2 --lite
    `,
    {
        importMeta: import.meta,
        flags: {
            model: {
                type: 'string',
                alias: 'm',
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
        },
    },
);

const rawModelFlag = cli.flags.model;
const rawReasoningFlag = cli.flags.reasoning;
const modelFlag =
    typeof rawModelFlag === 'string' && rawModelFlag.trim().length > 0
        ? rawModelFlag.trim()
        : undefined;
const reasoningEffort =
    typeof rawReasoningFlag === 'string' && rawReasoningFlag.trim().length > 0
        ? rawReasoningFlag.trim()
        : undefined;

const validReasoningEfforts = [
    'default',
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    null,
] as const;
type ModelSettingsReasoningEffort = (typeof validReasoningEfforts)[number];

const validatedReasoningEffort: ModelSettingsReasoningEffort | undefined =
    reasoningEffort && validReasoningEfforts.includes(reasoningEffort as any)
        ? (reasoningEffort as ModelSettingsReasoningEffort)
        : undefined;

// Apply CLI overrides to settings service
const cliOverrides: any = {};
if (modelFlag) {
    cliOverrides.agent = {model: modelFlag};
}

if (validatedReasoningEffort) {
    cliOverrides.agent = {
        ...cliOverrides.agent,
        reasoningEffort: validatedReasoningEffort,
    };
}

// Always set liteMode based on CLI flag (true if --lite passed, false otherwise)
// This ensures users can always get back to codebase mode by running without --lite
cliOverrides.app = {
    ...cliOverrides.app,
    liteMode: cli.flags.lite,
};

// Create LoggingService instance
const logger = new LoggingService({
    disableLogging: false,
});

const settings = new SettingsService({
    env: buildEnvOverrides(),
    cli: Object.keys(cliOverrides).length > 0 ? cliOverrides : undefined,
    loggingService: logger,
});

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
                resolvedPort = sshPortFlag !== 22 ? sshPortFlag : (hostConfig.port || 22);
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
            host: host,  // Use original alias for display
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

// Enforce mutual exclusion between lite mode and edit/mentor modes at startup
const liteMode = settings.get<boolean>('app.liteMode');
const editMode = settings.get<boolean>('app.editMode');
const mentorMode = settings.get<boolean>('app.mentorMode');

if (liteMode && (editMode || mentorMode)) {
    // Lite mode takes precedence, disable edit/mentor modes
    if (editMode) {
        settings.set('app.editMode', false);
    }
    if (mentorMode) {
        settings.set('app.mentorMode', false);
    }
}

const history = new HistoryService({
    loggingService: logger,
    settingsService: settings,
});

const usedModel = settings.get('agent.model');
const usedReasoningEffort = settings.get('agent.reasoningEffort');

const conversationService = new ConversationService({
    agentClient: new OpenAIAgentClient({
        model: usedModel,
        reasoningEffort: usedReasoningEffort as ModelSettingsReasoningEffort,
        maxTurns: settings.get('agent.maxTurns'),
        retryAttempts: settings.get('agent.retryAttempts'),
        deps: {
            logger: logger,
            settings: settings,
            executionContext: executionContext,
        },
    }),
    deps: {
        logger: logger,
    },
});

import {InputProvider} from './context/InputContext.js';

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
            />
        </InputProvider>
    ) as ReactNode,
    getInkRenderOptions(),
);

await waitUntilExit();
process.exit(0);
