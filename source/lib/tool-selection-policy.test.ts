import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import {
  shouldPreferPatchEditingModel,
  shouldUseNativePatchTool,
  shouldUseStrictToolSchema,
} from './tool-selection-policy.js';

it('shouldPreferPatchEditingModel returns true for gpt-5 models', () => {
  expect(shouldPreferPatchEditingModel('gpt-5')).toBe(true);
  expect(shouldPreferPatchEditingModel('gpt-5.1')).toBe(true);
  expect(shouldPreferPatchEditingModel('GPT-5-mini')).toBe(true);
});

it('shouldPreferPatchEditingModel returns false for non gpt-5 models', () => {
  expect(shouldPreferPatchEditingModel('gpt-4.1')).toBe(false);
  expect(shouldPreferPatchEditingModel('claude-3.7-sonnet')).toBe(false);
});

it('shouldUseNativePatchTool returns true for OpenAI gpt-5.1 models', () => {
  expect(
    shouldUseNativePatchTool({
      providerId: 'openai',
      model: 'gpt-5.1',
    }),
  ).toBe(true);
});

it('shouldUseNativePatchTool returns true for OpenAI gpt-5.10 and newer models', () => {
  expect(
    shouldUseNativePatchTool({
      providerId: 'openai',
      model: 'gpt-5.10',
    }),
  ).toBe(true);

  expect(
    shouldUseNativePatchTool({
      providerId: 'openai',
      model: 'gpt-6.0',
    }),
  ).toBe(true);
});

it('shouldUseNativePatchTool returns false for OpenAI non-5.1 models', () => {
  expect(
    shouldUseNativePatchTool({
      providerId: 'openai',
      model: 'gpt-5',
    }),
  ).toBe(false);
});

it('shouldUseNativePatchTool returns false for non-OpenAI providers', () => {
  expect(
    shouldUseNativePatchTool({
      providerId: 'openrouter',
      model: 'gpt-5.1',
    }),
  ).toBe(false);
});

it('shouldUseNativePatchTool honors provider model prefix capability', () => {
  expect(
    shouldUseNativePatchTool({
      providerId: 'custom-provider',
      model: 'custom-editor-v2',
      capabilities: {
        supportsConversationChaining: false,
        supportsTracingControl: false,
        nativePatchModelPrefixes: ['custom-editor'],
      },
    }),
  ).toBe(true);
});

it('shouldUseNativePatchTool treats gpt model prefixes semantically', () => {
  expect(
    shouldUseNativePatchTool({
      providerId: 'custom-provider',
      model: 'gpt-5.1-mini',
      capabilities: {
        supportsConversationChaining: false,
        supportsTracingControl: false,
        nativePatchModelPrefixes: ['gpt-5.1'],
      },
    }),
  ).toBe(true);

  expect(
    shouldUseNativePatchTool({
      providerId: 'custom-provider',
      model: 'gpt-6.0',
      capabilities: {
        supportsConversationChaining: false,
        supportsTracingControl: false,
        nativePatchModelPrefixes: ['gpt-5.1'],
      },
    }),
  ).toBe(true);

  expect(
    shouldUseNativePatchTool({
      providerId: 'custom-provider',
      model: 'gpt-5.0',
      capabilities: {
        supportsConversationChaining: false,
        supportsTracingControl: false,
        nativePatchModelPrefixes: ['gpt-5.1'],
      },
    }),
  ).toBe(false);
});

it('shouldUseStrictToolSchema returns true for OpenAI provider', () => {
  expect(
    shouldUseStrictToolSchema({
      providerId: 'openai',
    }),
  ).toBe(true);
});

it('shouldUseStrictToolSchema honors explicit provider capability', () => {
  expect(
    shouldUseStrictToolSchema({
      providerId: 'openai',
      capabilities: {
        supportsConversationChaining: true,
        supportsTracingControl: true,
        usesStrictToolSchema: false,
      },
    }),
  ).toBe(false);

  expect(
    shouldUseStrictToolSchema({
      providerId: 'custom-provider',
      capabilities: {
        supportsConversationChaining: false,
        supportsTracingControl: false,
        usesStrictToolSchema: true,
      },
    }),
  ).toBe(true);
});

it('shouldUseStrictToolSchema returns false for non-OpenAI provider', () => {
  expect(
    shouldUseStrictToolSchema({
      providerId: 'openrouter',
    }),
  ).toBe(false);
});
