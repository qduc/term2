#!/usr/bin/env node
import React from 'react';
import type {ReactNode} from 'react';
import {render} from 'ink';
import meow from 'meow';
import App from './app.js';
import {OpenAIAgentClient} from './lib/openai-agent-client.js';
import {ConversationService} from './services/conversation-service.js';
import {
    SettingsService,
    buildEnvOverrides,
} from './services/settings-service.js';
import {LoggingService} from './services/logging-service.js';
import {HistoryService} from './services/history-service.js';

// Global Ctrl+C handler for immediate exit
process.on('SIGINT', () => {
    process.exit(0);
});

const cli = meow(
    `
        Usage
          $ term2

        Options
          -m, --model  Override the default OpenAI model (e.g. gpt-4o)
          -r, --reasoning  Set the reasoning effort for reasoning models (e.g. medium, high)
          -c, --companion  Start in companion mode (watches your terminal and assists when needed)

        Examples
          $ term2 -m gpt-4o
          $ term2 --companion
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
            companion: {
                type: 'boolean',
                alias: 'c',
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

// Create LoggingService instance
const logger = new LoggingService({
    disableLogging: false,
});

const settings = new SettingsService({
    env: buildEnvOverrides(),
    cli: Object.keys(cliOverrides).length > 0 ? cliOverrides : undefined,
    loggingService: logger,
});

const history = new HistoryService({
    loggingService: logger,
    settingsService: settings,
});

const usedModel = settings.get('agent.model');
const usedReasoningEffort = settings.get('agent.reasoningEffort');

// Note: ESM requires static imports, so both mode's dependencies are loaded upfront.
// For significant startup optimization, consider dynamic import() for companion mode.
import {InputProvider} from './context/InputContext.js';
import {CompanionApp} from './modes/companion/index.js';

// Check if companion mode is requested
if (cli.flags.companion) {
    // Companion mode - wrap user's shell with AI assistance
    render(
        (<CompanionApp
            settingsService={settings}
            loggingService={logger}
        />) as ReactNode,
    );
} else {
    // Default chat mode
    const conversationService = new ConversationService({
        agentClient: new OpenAIAgentClient({
            model: usedModel,
            reasoningEffort: usedReasoningEffort as ModelSettingsReasoningEffort,
            maxTurns: settings.get('agent.maxTurns'),
            retryAttempts: settings.get('agent.retryAttempts'),
            deps: {
                logger: logger,
                settings: settings,
            },
        }),
        deps: {
            logger: logger,
        },
    });

    render(
        (
            <InputProvider>
                <App
                    conversationService={conversationService}
                    settingsService={settings}
                    historyService={history}
                    loggingService={logger}
                />
            </InputProvider>
        ) as ReactNode,
    );
}
