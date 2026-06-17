import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { SearchReplaceFullOperation } from './search-replace.js';
// @ts-ignore - TS module resolution for new tool file
import { healSearchReplaceParams } from './edit-healing.js';

const baseParams: SearchReplaceFullOperation = {
  path: 'file.txt',
  search_content: 'const foo = 2;\n',
  replace_content: 'const foo = 3;\n',
};

it('healSearchReplaceParams returns modified params when model finds a match', async () => {
  const fileContent = 'const foo = 1;\n\tconst bar = 2;\n';
  const runModel = async () => 'const foo = 1;\n\tconst bar = 2;';

  const result = await healSearchReplaceParams(baseParams, fileContent, 'gpt-4o-mini', 'fake-key', { runModel });

  expect(result.wasModified).toBe(true);
  expect(result.params.search_content).toBe('const foo = 1;\n\tconst bar = 2;');
  expect(result.confidence >= 0.6).toBe(true);
});

it('healSearchReplaceParams sends structured plain-text to the healing model', async () => {
  const fileContent = 'const fake = "<search>";\nconst foo = 1;\n';
  let capturedPrompt = '';
  const runModel = async (prompt: string) => {
    capturedPrompt = prompt;
    return 'const foo = 1;';
  };

  await healSearchReplaceParams(baseParams, fileContent, 'gpt-4o-mini', 'fake-key', { runModel });

  expect(capturedPrompt.startsWith('{')).toBe(false);
  expect(capturedPrompt.includes(baseParams.path)).toBe(true);
  expect(capturedPrompt.includes(baseParams.search_content)).toBe(true);
  expect(capturedPrompt.includes(baseParams.replace_content)).toBe(true);
  expect(capturedPrompt.includes(fileContent)).toBe(true);
});

it('healSearchReplaceParams swaps delimiter when default collides with content', async () => {
  const fileContent = 'line1\n---\nline2\n';
  let capturedPrompt = '';
  const runModel = async (prompt: string) => {
    capturedPrompt = prompt;
    return 'line2';
  };

  const params = { ...baseParams, search_content: 'line2', replace_content: 'line3' };
  await healSearchReplaceParams(params, fileContent, 'gpt-4o-mini', 'fake-key', { runModel });

  const lines = capturedPrompt.split('\n');
  const delimiterLine = lines.find(
    (l) => ['---', '===', '<<<>>>', '|||', '###BOUNDARY###'].includes(l) || l.startsWith('__DELIM_'),
  );
  expect(delimiterLine).toBeTruthy();
  expect(delimiterLine, 'should not use --- when it collides with content').not.toBe('---');
});

it('healSearchReplaceParams falls back to random delimiter when all candidates collide', async () => {
  const collisions = '---\n===\n<<<>>>\n|||\n###BOUNDARY###\n';
  const fileContent = `prefix\n${collisions}suffix\n`;
  let capturedPrompt = '';
  const runModel = async (prompt: string) => {
    capturedPrompt = prompt;
    return 'suffix';
  };

  const params = { ...baseParams, search_content: 'suffix', replace_content: 'new' };
  await healSearchReplaceParams(params, fileContent, 'gpt-4o-mini', 'fake-key', { runModel });

  const lines = capturedPrompt.split('\n');
  const randomDelim = lines.find((l) => l.startsWith('__DELIM_'));
  expect(randomDelim).toBeTruthy();
});

it('healSearchReplaceParams returns unmodified params on NO_MATCH', async () => {
  const fileContent = 'const foo = 1;\n';
  const runModel = async () => 'NO_MATCH';

  const result = await healSearchReplaceParams(baseParams, fileContent, 'gpt-4o-mini', 'fake-key', { runModel });

  expect(result.wasModified).toBe(false);
  expect(result.params.search_content).toBe(baseParams.search_content);
  expect(result.confidence).toBe(0);
  expect(result.failureReason).toBe('model returned NO_MATCH');
});

it('healSearchReplaceParams returns unmodified params for ambiguous matches', async () => {
  const fileContent = 'alpha\nbeta\nalpha\nbeta\n';
  const runModel = async () => 'alpha\nbeta';

  const result = await healSearchReplaceParams(baseParams, fileContent, 'gpt-4o-mini', 'fake-key', { runModel });

  expect(result.wasModified).toBe(false);
  expect(result.params.search_content).toBe(baseParams.search_content);
  expect(result.confidence).toBe(0);
  expect(result.failureReason).toBe('model output matched multiple locations');
});

it('healSearchReplaceParams returns unmodified params when model output is not in the file', async () => {
  const fileContent = 'const foo = 1;\n';
  const runModel = async () => 'const foo = 2;';

  const result = await healSearchReplaceParams(baseParams, fileContent, 'gpt-4o-mini', 'fake-key', { runModel });

  expect(result.wasModified).toBe(false);
  expect(result.params.search_content).toBe(baseParams.search_content);
  expect(result.confidence).toBe(0);
  expect(result.failureReason).toBe('model output was not found exactly in file');
});

it('healSearchReplaceParams returns unmodified params with low confidence reason', async () => {
  const fileContent = 'totally different content\n';
  const runModel = async () => 'totally different content';

  const result = await healSearchReplaceParams(baseParams, fileContent, 'gpt-4o-mini', 'fake-key', { runModel });

  expect(result.wasModified).toBe(false);
  expect(result.params.search_content).toBe(baseParams.search_content);
  expect(result.confidence < 0.6).toBe(true);
  expect(result.failureReason).toBe('model output similarity was below threshold');
});

it('healSearchReplaceParams uses tools.editHealingProvider before agent.provider', async () => {
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

  expect(providerId).toBe('openrouter');
});
