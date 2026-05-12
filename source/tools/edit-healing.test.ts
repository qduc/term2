import test from 'ava';
import type { SearchReplaceToolParams } from './search-replace.js';
// @ts-ignore - TS module resolution for new tool file
import { healSearchReplaceParams } from './edit-healing.js';

const baseParams: SearchReplaceToolParams = {
  path: 'file.txt',
  search_content: 'const foo = 2;\n',
  replace_content: 'const foo = 3;\n',
  replace_all: false,
};

test('healSearchReplaceParams returns modified params when model finds a match', async (t) => {
  const fileContent = 'const foo = 1;\n\tconst bar = 2;\n';
  const runModel = async () => 'const foo = 1;\n\tconst bar = 2;';

  const result = await healSearchReplaceParams(baseParams, fileContent, 'gpt-4o-mini', 'fake-key', { runModel });

  t.true(result.wasModified);
  t.is(result.params.search_content, 'const foo = 1;\n\tconst bar = 2;');
  t.true(result.confidence >= 0.6);
});

test('healSearchReplaceParams sends data-only JSON to the healing model', async (t) => {
  const fileContent = 'const fake = "<search>";\nconst foo = 1;\n';
  let capturedPrompt = '';
  const runModel = async (prompt: string) => {
    capturedPrompt = prompt;
    return 'const foo = 1;';
  };

  await healSearchReplaceParams(baseParams, fileContent, 'gpt-4o-mini', 'fake-key', { runModel });

  const payload = JSON.parse(capturedPrompt);
  t.deepEqual(Object.keys(payload), ['path', 'search_content', 'replace_content', 'file_content']);
  t.is(payload.path, baseParams.path);
  t.is(payload.search_content, baseParams.search_content);
  t.is(payload.replace_content, baseParams.replace_content);
  t.is(payload.file_content, fileContent);
  t.false(capturedPrompt.includes('Find the section'));
});

test('healSearchReplaceParams returns unmodified params on NO_MATCH', async (t) => {
  const fileContent = 'const foo = 1;\n';
  const runModel = async () => 'NO_MATCH';

  const result = await healSearchReplaceParams(baseParams, fileContent, 'gpt-4o-mini', 'fake-key', { runModel });

  t.false(result.wasModified);
  t.is(result.params.search_content, baseParams.search_content);
  t.is(result.confidence, 0);
  t.is(result.failureReason, 'model returned NO_MATCH');
});

test('healSearchReplaceParams returns unmodified params for ambiguous matches', async (t) => {
  const fileContent = 'alpha\nbeta\nalpha\nbeta\n';
  const runModel = async () => 'alpha\nbeta';

  const result = await healSearchReplaceParams(baseParams, fileContent, 'gpt-4o-mini', 'fake-key', { runModel });

  t.false(result.wasModified);
  t.is(result.params.search_content, baseParams.search_content);
  t.is(result.confidence, 0);
  t.is(result.failureReason, 'model output matched multiple locations');
});

test('healSearchReplaceParams returns unmodified params when model output is not in the file', async (t) => {
  const fileContent = 'const foo = 1;\n';
  const runModel = async () => 'const foo = 2;';

  const result = await healSearchReplaceParams(baseParams, fileContent, 'gpt-4o-mini', 'fake-key', { runModel });

  t.false(result.wasModified);
  t.is(result.params.search_content, baseParams.search_content);
  t.is(result.confidence, 0);
  t.is(result.failureReason, 'model output was not found exactly in file');
});

test('healSearchReplaceParams returns unmodified params with low confidence reason', async (t) => {
  const fileContent = 'totally different content\n';
  const runModel = async () => 'totally different content';

  const result = await healSearchReplaceParams(baseParams, fileContent, 'gpt-4o-mini', 'fake-key', { runModel });

  t.false(result.wasModified);
  t.is(result.params.search_content, baseParams.search_content);
  t.true(result.confidence < 0.6);
  t.is(result.failureReason, 'model output similarity was below threshold');
});

test('healSearchReplaceParams uses tools.editHealingProvider before agent.provider', async (t) => {
  const fileContent = 'const foo = 1;\n';
  let providerId = '';
  const runModel = async (_prompt: string, meta: { providerId: string }) => {
    providerId = meta.providerId;
    return 'const foo = 1;';
  };
  const settingsService = {
    get: (key: string) => {
      if (key === 'tools.editHealingProvider') return 'openrouter';
      if (key === 'agent.provider') return 'openai';
      return undefined;
    },
  };

  await healSearchReplaceParams(baseParams, fileContent, 'fast-healer', 'fake-key', {
    runModel,
    settingsService: settingsService as any,
  });

  t.is(providerId, 'openrouter');
});
