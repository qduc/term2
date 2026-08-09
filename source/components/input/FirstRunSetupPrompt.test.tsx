// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import React from 'react';
import { expect, it } from 'vitest';
import { renderInAct } from '../../test-helpers/ink-testing.js';
import { FirstRunSetupPrompt } from './FirstRunSetupPrompt.js';

it('guides a blank install through provider credentials before model selection', async () => {
  const { lastFrame } = await renderInAct(<FirstRunSetupPrompt phase="provider" provider="openai" />);

  expect(lastFrame()).toContain('First-run setup');
  expect(lastFrame()).toContain('Choose a provider and configure its credentials');
  expect(lastFrame()).toContain('Normal chat is disabled until setup completes');
});

it('gives Codex login guidance while the provider is being configured', async () => {
  const { lastFrame } = await renderInAct(<FirstRunSetupPrompt phase="provider" provider="codex" />);

  expect(lastFrame()).toContain('npx @openai/codex login');
  expect(lastFrame()).toContain('reselect Codex to');
  expect(lastFrame()).toContain('retry.');
});

it('guides the user to model selection after credentials are present', async () => {
  const { lastFrame } = await renderInAct(<FirstRunSetupPrompt phase="model" provider="openai" />);

  expect(lastFrame()).toContain('Credentials found for OpenAI');
  expect(lastFrame()).toContain('Choose a model to finish setup');
});
