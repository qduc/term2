import { describe, it, expect, vi } from 'vitest';
import { healPatchOperation, parseDiffStructure, countContextMatchesInFile } from './patch-healing.js';

describe('patch-healing', () => {
  describe('parseDiffStructure & countContextMatchesInFile', () => {
    it('parses added, deleted, and context lines correctly from a diff', () => {
      const diff = ['@@ function foo', ' function foo() {', '-  const oldVal = 1;', '+  const newVal = 2;', ' }'].join(
        '\n',
      );

      const parsed = parseDiffStructure(diff);
      expect(parsed.addedLines).toEqual(['  const newVal = 2;']);
      expect(parsed.deletedLines).toEqual(['  const oldVal = 1;']);
      expect(parsed.chunks.length).toBe(1);
      expect(parsed.chunks[0].contextLines).toEqual(['function foo() {', '  const oldVal = 1;', '}']);
    });

    it('counts exact and trimmed context matches in file correctly', () => {
      const fileContent = [
        'function foo() {',
        '  const bar = 10;',
        '}',
        'function foo() {',
        '  const bar = 20;',
        '}',
      ].join('\n');

      expect(countContextMatchesInFile(fileContent, ['function foo() {', '  const bar = 10;'])).toBe(1);
      expect(countContextMatchesInFile(fileContent, ['function foo() {'])).toBe(2);
      expect(countContextMatchesInFile(fileContent, ['function missing() {'])).toBe(0);
    });
  });

  describe('healPatchOperation', () => {
    const mockFileContent = [
      '// Header comment',
      'function computeTotal(items: number[]): number {',
      '  let sum = 0;',
      '  for (const item of items) {',
      '    sum += item;',
      '  }',
      '  return sum;',
      '}',
    ].join('\n');

    const failedDiff = [
      '@@ function calculateTotal',
      ' function calculateTotal(items: number[]): number {',
      '-  let sum = 0;',
      '+  let sum = 10;',
      '   for (const item of items) {',
    ].join('\n');

    it('heals stale context when added and deleted lines are preserved', async () => {
      const healedDiff = [
        '@@ function computeTotal',
        ' function computeTotal(items: number[]): number {',
        '-  let sum = 0;',
        '+  let sum = 10;',
        '   for (const item of items) {',
      ].join('\n');

      const runModel = vi.fn().mockResolvedValue(healedDiff);

      const result = await healPatchOperation(
        'source/calc.ts',
        failedDiff,
        mockFileContent,
        'Mismatch diagnosis',
        'gpt-4o-mini',
        'test-key',
        { runModel },
      );

      expect(result.wasModified).toBe(true);
      expect(result.healedDiff).toBe(healedDiff);
      expect(result.failureReason).toBeUndefined();
    });

    it('rejects healed diff if added lines were modified', async () => {
      const invalidHealedDiff = [
        '@@ function computeTotal',
        ' function computeTotal(items: number[]): number {',
        '-  let sum = 0;',
        '+  let sum = 999;', // Modified addition!
        '   for (const item of items) {',
        ' }',
      ].join('\n');

      const runModel = vi.fn().mockResolvedValue(invalidHealedDiff);

      const result = await healPatchOperation(
        'source/calc.ts',
        failedDiff,
        mockFileContent,
        'Mismatch diagnosis',
        'gpt-4o-mini',
        'test-key',
        { runModel },
      );

      expect(result.wasModified).toBe(false);
      expect(result.failureReason).toBe('healed diff modified added lines');
    });

    it('rejects healed diff if deleted lines were modified', async () => {
      const invalidHealedDiff = [
        '@@ function computeTotal',
        ' function computeTotal(items: number[]): number {',
        '-  let total = 0;', // Modified deletion!
        '+  let sum = 10;',
        '   for (const item of items) {',
        ' }',
      ].join('\n');

      const runModel = vi.fn().mockResolvedValue(invalidHealedDiff);

      const result = await healPatchOperation(
        'source/calc.ts',
        failedDiff,
        mockFileContent,
        'Mismatch diagnosis',
        'gpt-4o-mini',
        'test-key',
        { runModel },
      );

      expect(result.wasModified).toBe(false);
      expect(result.failureReason).toBe('healed diff modified deleted lines');
    });

    it('rejects healed diff if context matches multiple locations (ambiguity rejection)', async () => {
      const ambiguousFile = [
        '  let sum = 0;',
        '  for (const item of items) {',
        '  }',
        '  let sum = 0;',
        '  for (const item of items) {',
        '  }',
      ].join('\n');

      const ambiguousDiff = ['@@ sum', '-  let sum = 0;', '+  let sum = 10;', '   for (const item of items) {'].join(
        '\n',
      );

      const runModel = vi.fn().mockResolvedValue(ambiguousDiff);

      const result = await healPatchOperation(
        'source/calc.ts',
        failedDiff,
        ambiguousFile,
        'Mismatch diagnosis',
        'gpt-4o-mini',
        'test-key',
        { runModel },
      );

      expect(result.wasModified).toBe(false);
      expect(result.failureReason).toBe('healed context matched multiple locations');
    });

    it('handles healer model errors gracefully', async () => {
      const runModel = vi.fn().mockRejectedValue(new Error('Model timeout'));

      const result = await healPatchOperation(
        'source/calc.ts',
        failedDiff,
        mockFileContent,
        'Mismatch diagnosis',
        'gpt-4o-mini',
        'test-key',
        { runModel },
      );

      expect(result.wasModified).toBe(false);
      expect(result.failureReason).toBe('healing request failed: Model timeout');
    });

    it('handles NO_MATCH output gracefully', async () => {
      const runModel = vi.fn().mockResolvedValue('NO_MATCH');

      const result = await healPatchOperation(
        'source/calc.ts',
        failedDiff,
        mockFileContent,
        'Mismatch diagnosis',
        'gpt-4o-mini',
        'test-key',
        { runModel },
      );

      expect(result.wasModified).toBe(false);
      expect(result.failureReason).toBe('model returned NO_MATCH');
    });
  });
});
