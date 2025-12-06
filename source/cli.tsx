#!/usr/bin/env node
import React from 'react';
import type {ReactNode} from 'react';
import {render} from 'ink';
import meow from 'meow';
import App from './app.js';
import {OpenAIAgentClient} from './lib/openai-agent-client.js';
import {ConversationService} from './services/conversation-service.js';
import {SettingsService} from './services/settings-service.js';

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

		Examples
		  $ term2 -m gpt-4o
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

const settings = new SettingsService({
	cli: Object.keys(cliOverrides).length > 0 ? cliOverrides : undefined,
});
const usedModel = settings.get('agent.model');
const usedReasoningEffort = settings.get('agent.reasoningEffort');

// Print which model and reasoning effort will be used on startup
process.stderr.write(
	`Using model: ${usedModel}` +
		(usedReasoningEffort &&
		usedReasoningEffort !== 'none' &&
		usedReasoningEffort !== 'default'
			? ` with reasoning effort: ${usedReasoningEffort}`
			: '') +
		'\n',
);

const conversationService = new ConversationService({
	agentClient: new OpenAIAgentClient({
		model: usedModel,
		reasoningEffort: usedReasoningEffort as ModelSettingsReasoningEffort,
		maxTurns: settings.get('agent.maxTurns'),
		retryAttempts: settings.get('agent.retryAttempts'),
	}),
});

render((<App conversationService={conversationService} />) as ReactNode);
