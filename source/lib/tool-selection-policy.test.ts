import { it, expect } from 'vitest';
import {
  shouldPreferPatchEditingModel,
  isGpt5OrGpt6Model,
  shouldUseNativePatchTool,
  shouldUseStrictToolSchema,
} from './tool-selection-policy.js';

it('modern GPT model detection includes GPT-5 and GPT-6 families', () => {
  expect(isGpt5OrGpt6Model('gpt-5')).toBe(true);
  expect(isGpt5OrGpt6Model('gpt-5.1')).toBe(true);
  expect(isGpt5OrGpt6Model('GPT-5-mini')).toBe(true);
  expect(isGpt5OrGpt6Model('gpt-6')).toBe(true);
  expect(isGpt5OrGpt6Model('openai/gpt-6.1-codex')).toBe(true);
});

it('shouldPreferPatchEditingModel returns true for modern GPT models', () => {
  expect(shouldPreferPatchEditingModel('gpt-5')).toBe(true);
  expect(shouldPreferPatchEditingModel('gpt-5.1')).toBe(true);
  expect(shouldPreferPatchEditingModel('GPT-5-mini')).toBe(true);
  expect(shouldPreferPatchEditingModel('gpt-6')).toBe(true);
});

it('modern GPT model detection returns false for other models', () => {
  expect(shouldPreferPatchEditingModel('gpt-4.1')).toBe(false);
  expect(shouldPreferPatchEditingModel('claude-3.7-sonnet')).toBe(false);
  expect(isGpt5OrGpt6Model('gpt-7')).toBe(false);
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
        usesStrictToolSchema: false,
      },
    }),
  ).toBe(false);

  expect(
    shouldUseStrictToolSchema({
      providerId: 'custom-provider',
      capabilities: {
        supportsConversationChaining: false,
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
