import test from 'ava';
import {
    trimOutput,
    setTrimConfig,
    getTrimConfig,
    DEFAULT_TRIM_CONFIG,
} from '../../dist/utils/output-trim.js';

test('returns output unchanged when below both limits', t => {
    const output = 'line1\nline2\nline3';
    const result = trimOutput(output);
    t.is(result, output);
});

test('trims output when exceeding line limit', t => {
    // Create output with more than default max lines (1000)
    const lines = [];
    for (let i = 1; i <= 1200; i++) {
        lines.push(`line ${i}`);
    }
    const output = lines.join('\n');
    const result = trimOutput(output);

    // Should contain trimmed message
    t.true(result.includes('lines trimmed'));
    // Should have first 40% of lines (400 lines)
    t.true(result.includes('line 1'));
    t.true(result.includes('line 400'));
    // Should have last 40% of lines (400 lines)
    t.true(result.includes('line 801'));
    t.true(result.includes('line 1200'));
    // Middle section should be missing
    t.false(result.includes('line 600'));
});

test('trims output when exceeding character limit', t => {
    // Create output that exceeds character limit but not line limit
    const output = 'a'.repeat(15000);
    const result = trimOutput(output);

    t.true(result.includes('characters trimmed'));
    t.true(result.length < output.length);
});

test('respects maxLines override parameter', t => {
    const lines = [];
    for (let i = 1; i <= 100; i++) {
        lines.push(`line ${i}`);
    }
    const output = lines.join('\n');

    // Override to max 50 lines
    const result = trimOutput(output, 50, undefined);

    t.true(result.includes('lines trimmed'));
    // Should keep 40% from start (20 lines) and 40% from end (20 lines)
    t.true(result.includes('line 1'));
    t.true(result.includes('line 20'));
    t.true(result.includes('line 81'));
    t.true(result.includes('line 100'));
});

test('respects maxCharacters override parameter', t => {
    // Create output with 1000 characters (single line)
    const output = 'a'.repeat(1000);

    // Override to max 500 characters
    const result = trimOutput(output, undefined, 500);

    t.true(result.includes('characters trimmed'));
    t.true(result.length < output.length);
});

test('does not trim when lines are equal to keepLines * 2', t => {
    // With default maxLines 1000, keepLines = 400
    // Create exactly 800 lines (keepLines * 2)
    const lines = [];
    for (let i = 1; i <= 800; i++) {
        lines.push(`line ${i}`);
    }
    const output = lines.join('\n');
    const result = trimOutput(output);

    // Should not trim when lines <= effectiveKeepLines * 2
    t.is(result, output);
});

test('ensures minimum of 10 lines are kept', t => {
    // Set very small limits
    const lines = [];
    for (let i = 1; i <= 50; i++) {
        lines.push(`line ${i}`);
    }
    const output = lines.join('\n');

    // Override with very small maxLines
    const result = trimOutput(output, 5, undefined);

    // Should keep at least 10 lines at start and 10 at end (total 20+)
    t.true(result.includes('line 1'));
    t.true(result.includes('line 10'));
    t.true(result.includes('line 41'));
    t.true(result.includes('line 50'));
});

test('shows correct trimmed count in message', t => {
    const lines = [];
    for (let i = 1; i <= 1100; i++) {
        lines.push(`line ${i}`);
    }
    const output = lines.join('\n');
    const result = trimOutput(output);

    // With 1100 lines and default max 1000, keeps 400 at start + 400 at end = 300 trimmed
    t.true(result.includes('[300 lines trimmed]'));
});

test('setTrimConfig updates configuration', t => {
    // Save original config
    const original = getTrimConfig();

    try {
        setTrimConfig({maxLines: 500, maxCharacters: 5000});
        const config = getTrimConfig();

        t.is(config.maxLines, 500);
        t.is(config.maxCharacters, 5000);
    } finally {
        // Restore original config
        setTrimConfig(original);
    }
});

test('setTrimConfig accepts partial configuration', t => {
    // Save original config
    const original = getTrimConfig();

    try {
        setTrimConfig({maxLines: 300});
        const config = getTrimConfig();

        t.is(config.maxLines, 300);
        // maxCharacters should remain at default
        t.is(config.maxCharacters, DEFAULT_TRIM_CONFIG.maxCharacters);
    } finally {
        // Restore original config
        setTrimConfig(original);
    }
});

test('getTrimConfig returns copy of config', t => {
    const config1 = getTrimConfig();
    const config2 = getTrimConfig();

    // Should be equal but not same reference
    t.deepEqual(config1, config2);
    t.not(config1, config2);
});

test('DEFAULT_TRIM_CONFIG has expected values', t => {
    t.is(DEFAULT_TRIM_CONFIG.maxLines, 1000);
    t.is(DEFAULT_TRIM_CONFIG.maxCharacters, 10000);
});

test('trimOutput uses updated config after setTrimConfig', t => {
    // Save original config
    const original = getTrimConfig();

    try {
        // Set very low limits
        setTrimConfig({maxLines: 10, maxCharacters: 100});

        const lines = [];
        for (let i = 1; i <= 50; i++) {
            lines.push(`line ${i}`);
        }
        const output = lines.join('\n');
        const result = trimOutput(output);

        // Should trim with new config
        t.true(result.includes('lines trimmed'));
    } finally {
        // Restore original config
        setTrimConfig(original);
    }
});

test('handles empty string', t => {
    const result = trimOutput('');
    t.is(result, '');
});

test('handles single line', t => {
    const result = trimOutput('single line');
    t.is(result, 'single line');
});

test('preserves newlines in trimmed output', t => {
    const lines = [];
    for (let i = 1; i <= 100; i++) {
        lines.push(`line ${i}`);
    }
    const output = lines.join('\n');
    const result = trimOutput(output, 50, undefined);

    // Should have newlines preserved
    const resultLines = result.split('\n');
    t.true(resultLines.length > 0);
    // Should have trim message as a separate element
    t.true(resultLines.some(line => line.includes('lines trimmed')));
});
