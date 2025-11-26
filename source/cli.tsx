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
		},
	},
);

const rawModelFlag = cli.flags.model;
const modelFlag =
	typeof rawModelFlag === 'string' && rawModelFlag.trim().length > 0
		? rawModelFlag.trim()
		: undefined;

const usedModel = modelFlag ?? DEFAULT_MODEL;

// Print which model will be used on startup
console.log(`Using model: ${usedModel}`);

const conversationService = modelFlag
	? new ConversationService({
			agentClient: new OpenAIAgentClient({model: modelFlag}),
	  })
	: undefined;

render((<App conversationService={conversationService} />) as ReactNode);
