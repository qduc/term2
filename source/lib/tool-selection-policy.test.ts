import test from 'ava';
import {
  shouldPreferPatchEditingModel,
  shouldUseNativePatchTool,
  shouldUseStrictToolSchema,
} from './tool-selection-policy.js';

test('shouldPreferPatchEditingModel returns true for gpt-5 models', (t) => {
  t.true(shouldPreferPatchEditingModel('gpt-5'));
  t.true(shouldPreferPatchEditingModel('gpt-5.1'));
  t.true(shouldPreferPatchEditingModel('GPT-5-mini'));
});

test('shouldPreferPatchEditingModel returns false for non gpt-5 models', (t) => {
  t.false(shouldPreferPatchEditingModel('gpt-4.1'));
  t.false(shouldPreferPatchEditingModel('claude-3.7-sonnet'));
});

test('shouldUseNativePatchTool returns true for OpenAI gpt-5.1 models', (t) => {
  t.true(
    shouldUseNativePatchTool({
      providerId: 'openai',
      model: 'gpt-5.1',
    }),
  );
});

test('shouldUseNativePatchTool returns true for OpenAI gpt-5.10 and newer models', (t) => {
  t.true(
    shouldUseNativePatchTool({
      providerId: 'openai',
      model: 'gpt-5.10',
    }),
  );

  t.true(
    shouldUseNativePatchTool({
      providerId: 'openai',
      model: 'gpt-6.0',
    }),
  );
});

test('shouldUseNativePatchTool returns false for OpenAI non-5.1 models', (t) => {
  t.false(
    shouldUseNativePatchTool({
      providerId: 'openai',
      model: 'gpt-5',
    }),
  );
});

test('shouldUseNativePatchTool returns false for non-OpenAI providers', (t) => {
  t.false(
    shouldUseNativePatchTool({
      providerId: 'openrouter',
      model: 'gpt-5.1',
    }),
  );
});

test('shouldUseNativePatchTool honors provider model prefix capability', (t) => {
  t.true(
    shouldUseNativePatchTool({
      providerId: 'custom-provider',
      model: 'custom-editor-v2',
      capabilities: {
        supportsConversationChaining: false,
        supportsTracingControl: false,
        nativePatchModelPrefixes: ['custom-editor'],
      },
    }),
  );
});

test('shouldUseNativePatchTool treats gpt model prefixes semantically', (t) => {
  t.true(
    shouldUseNativePatchTool({
      providerId: 'custom-provider',
      model: 'gpt-5.1-mini',
      capabilities: {
        supportsConversationChaining: false,
        supportsTracingControl: false,
        nativePatchModelPrefixes: ['gpt-5.1'],
      },
    }),
  );

  t.true(
    shouldUseNativePatchTool({
      providerId: 'custom-provider',
      model: 'gpt-6.0',
      capabilities: {
        supportsConversationChaining: false,
        supportsTracingControl: false,
        nativePatchModelPrefixes: ['gpt-5.1'],
      },
    }),
  );

  t.false(
    shouldUseNativePatchTool({
      providerId: 'custom-provider',
      model: 'gpt-5.0',
      capabilities: {
        supportsConversationChaining: false,
        supportsTracingControl: false,
        nativePatchModelPrefixes: ['gpt-5.1'],
      },
    }),
  );
});

test('shouldUseStrictToolSchema returns true for OpenAI provider', (t) => {
  t.true(
    shouldUseStrictToolSchema({
      providerId: 'openai',
    }),
  );
});

test('shouldUseStrictToolSchema honors explicit provider capability', (t) => {
  t.false(
    shouldUseStrictToolSchema({
      providerId: 'openai',
      capabilities: {
        supportsConversationChaining: true,
        supportsTracingControl: true,
        usesStrictToolSchema: false,
      },
    }),
  );

  t.true(
    shouldUseStrictToolSchema({
      providerId: 'custom-provider',
      capabilities: {
        supportsConversationChaining: false,
        supportsTracingControl: false,
        usesStrictToolSchema: true,
      },
    }),
  );
});

test('shouldUseStrictToolSchema returns false for non-OpenAI provider', (t) => {
  t.false(
    shouldUseStrictToolSchema({
      providerId: 'openrouter',
    }),
  );
});
