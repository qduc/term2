import { it, expect } from 'vitest';
import { trimOutput, setTrimConfig, getTrimConfig, DEFAULT_TRIM_CONFIG } from './output-trim.js';

it('returns output unchanged when below both limits', () => {
  const output = 'line1\nline2\nline3';
  const result = trimOutput(output);
  expect(result).toBe(output);
});

it('trims output when exceeding line limit', () => {
  // Create output with more than default max lines (1000)
  const lines = Array<string>();
  for (let i = 1; i <= 1200; i++) {
    lines.push(`line ${i}`);
  }
  const output = lines.join('\n');
  const result = trimOutput(output);

  // Should contain trimmed message
  expect(result.includes('lines trimmed')).toBe(true);
  // Should have first 40% of lines (400 lines)
  expect(result.includes('line 1')).toBe(true);
  expect(result.includes('line 400')).toBe(true);
  // Should have last 40% of lines (400 lines)
  expect(result.includes('line 801')).toBe(true);
  expect(result.includes('line 1200')).toBe(true);
  // Middle section should be missing
  expect(result.includes('line 600')).toBe(false);
});

it('trims output when exceeding character limit', () => {
  // Create output that exceeds character limit but not line limit
  const output = 'a'.repeat(50000);
  const result = trimOutput(output);

  expect(result.includes('characters trimmed')).toBe(true);
  expect(result.length < output.length).toBe(true);
});

it('trims few-line output with one very long line by character limit', () => {
  const lines = Array.from({ length: 21 }, (_, index) =>
    index === 18 ? `huge:${'a'.repeat(15000)}` : `line ${index + 1}`,
  );
  const output = lines.join('\n');
  const result = trimOutput(output, 50, 1000);

  expect(result.includes('characters trimmed')).toBe(true);
  expect(result.length < 2000).toBe(true);
  expect(result.includes('a'.repeat(5000))).toBe(false);
});

it('respects maxLines override parameter', () => {
  const lines = Array<string>();
  for (let i = 1; i <= 100; i++) {
    lines.push(`line ${i}`);
  }
  const output = lines.join('\n');

  // Override to max 50 lines
  const result = trimOutput(output, 50, undefined);

  expect(result.includes('lines trimmed')).toBe(true);
  // Should keep 40% from start (20 lines) and 40% from end (20 lines)
  expect(result.includes('line 1')).toBe(true);
  expect(result.includes('line 20')).toBe(true);
  expect(result.includes('line 81')).toBe(true);
  expect(result.includes('line 100')).toBe(true);
});

it('respects maxCharacters override parameter', () => {
  // Create output with 1000 characters (single line)
  const output = 'a'.repeat(1000);

  // Override to max 500 characters
  const result = trimOutput(output, undefined, 500);

  expect(result.includes('characters trimmed')).toBe(true);
  expect(result.length < output.length).toBe(true);
});

it('does not trim when lines are equal to keepLines * 2', () => {
  // With default maxLines 1000, keepLines = 400
  // Create exactly 800 lines (keepLines * 2)
  const lines = Array<string>();
  for (let i = 1; i <= 800; i++) {
    lines.push(`line ${i}`);
  }
  const output = lines.join('\n');
  const result = trimOutput(output);

  // Should not trim when lines <= effectiveKeepLines * 2
  expect(result).toBe(output);
});

it('ensures minimum of 10 lines are kept', () => {
  // Set very small limits
  const lines = Array<string>();
  for (let i = 1; i <= 50; i++) {
    lines.push(`line ${i}`);
  }
  const output = lines.join('\n');

  // Override with very small maxLines
  const result = trimOutput(output, 5, undefined);

  // Should keep at least 10 lines at start and 10 at end (total 20+)
  expect(result.includes('line 1')).toBe(true);
  expect(result.includes('line 10')).toBe(true);
  expect(result.includes('line 41')).toBe(true);
  expect(result.includes('line 50')).toBe(true);
});

it('shows correct trimmed count in message', () => {
  const lines = Array<string>();
  for (let i = 1; i <= 1100; i++) {
    lines.push(`line ${i}`);
  }
  const output = lines.join('\n');
  const result = trimOutput(output);

  // With 1100 lines and default max 1000, keeps 400 at start + 400 at end = 300 trimmed
  expect(result.includes('[300 lines trimmed]')).toBe(true);
});

it('setTrimConfig updates configuration', () => {
  // Save original config
  const original = getTrimConfig();

  try {
    setTrimConfig({ maxLines: 500, maxCharacters: 5000 });
    const config = getTrimConfig();

    expect(config.maxLines).toBe(500);
    expect(config.maxCharacters).toBe(5000);
  } finally {
    // Restore original config
    setTrimConfig(original);
  }
});

it('setTrimConfig accepts partial configuration', () => {
  // Save original config
  const original = getTrimConfig();

  try {
    setTrimConfig({ maxLines: 300 });
    const config = getTrimConfig();

    expect(config.maxLines).toBe(300);
    // maxCharacters should remain at default
    expect(config.maxCharacters).toBe(DEFAULT_TRIM_CONFIG.maxCharacters);
  } finally {
    // Restore original config
    setTrimConfig(original);
  }
});

it('getTrimConfig returns copy of config', () => {
  const config1 = getTrimConfig();
  const config2 = getTrimConfig();

  // Should be equal but not same reference
  expect(config1).toEqual(config2);
  expect(config1).not.toBe(config2);
});

it('DEFAULT_TRIM_CONFIG has expected values', () => {
  expect(DEFAULT_TRIM_CONFIG.maxLines).toBe(1000);
  expect(DEFAULT_TRIM_CONFIG.maxCharacters).toBe(40000);
});

it('trimOutput uses updated config after setTrimConfig', () => {
  // Save original config
  const original = getTrimConfig();

  try {
    // Set very low limits
    setTrimConfig({ maxLines: 10, maxCharacters: 100 });

    const lines = Array<string>();
    for (let i = 1; i <= 50; i++) {
      lines.push(`line ${i}`);
    }
    const output = lines.join('\n');
    const result = trimOutput(output);

    // Should trim with new config
    expect(result.includes('lines trimmed')).toBe(true);
  } finally {
    // Restore original config
    setTrimConfig(original);
  }
});

it('handles empty string', () => {
  const result = trimOutput('');
  expect(result).toBe('');
});

it('handles single line', () => {
  const result = trimOutput('single line');
  expect(result).toBe('single line');
});

it('preserves newlines in trimmed output', () => {
  const lines = Array<string>();
  for (let i = 1; i <= 100; i++) {
    lines.push(`line ${i}`);
  }
  const output = lines.join('\n');
  const result = trimOutput(output, 50, undefined);

  // Should have newlines preserved
  const resultLines = result.split('\n');
  expect(resultLines.length > 0).toBe(true);
  // Should have trim message as a separate element
  expect(resultLines.some((line) => line.includes('lines trimmed'))).toBe(true);
});
