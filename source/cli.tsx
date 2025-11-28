#!/usr/bin/env node
import React from 'react';
import type {ReactNode} from 'react';
import {render} from 'ink';
import meow from 'meow';
import App from './app.js';
import {DEFAULT_MODEL} from './agent.js';
import {OpenAIAgentClient} from './lib/openai-agent-client.js';
import {ConversationService} from './services/conversation-service.js';

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
const usedModel = modelFlag ?? DEFAULT_MODEL;
const reasoningEffort =
	typeof rawReasoningFlag === 'string' && rawReasoningFlag.trim().length > 0
		? rawReasoningFlag.trim()
		: undefined;

// Print which model and reasoning effort will be used on startup
console.log(
	`Using model: ${usedModel}` +
		(reasoningEffort ? ` with reasoning effort: ${reasoningEffort}` : ''),
);

const conversationService = new ConversationService({
	agentClient: new OpenAIAgentClient({
		model: usedModel,
		reasoningEffort,
	}),
});

render((<App conversationService={conversationService} />) as ReactNode);
