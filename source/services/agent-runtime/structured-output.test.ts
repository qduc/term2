import { describe, it, expect } from 'vitest';
import {
  validateSchemaKeywords,
  validateAgainstSchema,
  validateOutputSchema,
  formatOutputContract,
  parseAndValidateOutput,
} from './structured-output.js';

describe('validateSchemaKeywords', () => {
  it('accepts basic type schema', () => {
    expect(validateSchemaKeywords({ type: 'object' })).toEqual([]);
  });

  it('accepts schema with properties, required, enum', () => {
    expect(
      validateSchemaKeywords({
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      }),
    ).toEqual([]);
  });

  it('accepts schema with items (arrays)', () => {
    expect(
      validateSchemaKeywords({
        type: 'array',
        items: { type: 'string', enum: ['a', 'b'] },
      }),
    ).toEqual([]);
  });

  it('rejects unsupported top-level keywords', () => {
    const unsupported = validateSchemaKeywords({
      type: 'object',
      pattern: '^foo',
      minimum: 1,
    });
    expect(unsupported).toContain('pattern');
    expect(unsupported).toContain('minimum');
  });

  it('rejects unsupported keywords in nested properties', () => {
    const unsupported = validateSchemaKeywords({
      type: 'object',
      properties: {
        age: { type: 'number', minimum: 0, maximum: 120 },
      },
    });
    expect(unsupported).toContain('properties.age.minimum');
    expect(unsupported).toContain('properties.age.maximum');
  });

  it('rejects unsupported keywords in items', () => {
    const unsupported = validateSchemaKeywords({
      type: 'array',
      items: { type: 'string', minLength: 1 },
    });
    expect(unsupported).toContain('items.minLength');
  });

  it('silently strips $schema keyword', () => {
    expect(validateSchemaKeywords({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' })).toEqual([]);
  });
});

describe('validateAgainstSchema', () => {
  it('validates string type', () => {
    expect(validateAgainstSchema('hello', { type: 'string' })).toEqual([]);
    expect(validateAgainstSchema(42, { type: 'string' }).length).toBeGreaterThan(0);
  });

  it('validates number type', () => {
    expect(validateAgainstSchema(42, { type: 'number' })).toEqual([]);
    expect(validateAgainstSchema('42', { type: 'number' }).length).toBeGreaterThan(0);
  });

  it('validates integer type', () => {
    expect(validateAgainstSchema(42, { type: 'integer' })).toEqual([]);
    expect(validateAgainstSchema(42.5, { type: 'integer' }).length).toBeGreaterThan(0);
  });

  it('validates boolean type', () => {
    expect(validateAgainstSchema(true, { type: 'boolean' })).toEqual([]);
    expect(validateAgainstSchema('true', { type: 'boolean' }).length).toBeGreaterThan(0);
  });

  it('validates array type', () => {
    expect(validateAgainstSchema([1, 2], { type: 'array' })).toEqual([]);
    expect(validateAgainstSchema({}, { type: 'array' }).length).toBeGreaterThan(0);
  });

  it('validates null type', () => {
    expect(validateAgainstSchema(null, { type: 'null' })).toEqual([]);
    expect(validateAgainstSchema(undefined, { type: 'null' }).length).toBeGreaterThan(0);
  });

  it('validates object with properties', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
      required: ['name'],
    };
    expect(validateAgainstSchema({ name: 'Alice', age: 30 }, schema)).toEqual([]);
    expect(validateAgainstSchema({ age: 30 }, schema).length).toBeGreaterThan(0); // missing name
    expect(validateAgainstSchema({ name: 'Bob', age: 'thirty' }, schema).length).toBeGreaterThan(0); // wrong type
  });

  it('validates enum values', () => {
    const schema = { enum: ['red', 'green', 'blue'] };
    expect(validateAgainstSchema('red', schema)).toEqual([]);
    expect(validateAgainstSchema('yellow', schema).length).toBeGreaterThan(0);
  });

  it('validates enum with object values', () => {
    const schema = { enum: [{ status: 'ok' }, { status: 'error' }] };
    expect(validateAgainstSchema({ status: 'ok' }, schema)).toEqual([]);
    expect(validateAgainstSchema({ status: 'pending' }, schema).length).toBeGreaterThan(0);
  });

  it('validates array items', () => {
    const schema = { type: 'array', items: { type: 'string' } };
    expect(validateAgainstSchema(['a', 'b'], schema)).toEqual([]);
    expect(validateAgainstSchema(['a', 42], schema).length).toBeGreaterThan(0);
  });

  it('rejects additional properties when additionalProperties is false', () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' } },
      additionalProperties: false,
    };
    expect(validateAgainstSchema({ name: 'Alice' }, schema)).toEqual([]);
    expect(validateAgainstSchema({ name: 'Alice', extra: 1 }, schema).length).toBeGreaterThan(0);
  });

  it('allows additional properties by default', () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' } },
    };
    expect(validateAgainstSchema({ name: 'Alice', extra: 1 }, schema)).toEqual([]);
  });
});

describe('validateOutputSchema', () => {
  it('accepts a valid simple schema', () => {
    expect(validateOutputSchema({ schema: { type: 'object', properties: { x: { type: 'number' } } } })).toBeNull();
  });

  it('rejects null schema', () => {
    const err = validateOutputSchema({ schema: null as any });
    expect(err).not.toBeNull();
    expect(err!.code).toBe('invalid_schema');
  });

  it('rejects schemas with unsupported keywords', () => {
    const err = validateOutputSchema({ schema: { type: 'string', pattern: '^test' } });
    expect(err).not.toBeNull();
    expect(err!.code).toBe('invalid_schema');
    expect(err!.message).toContain('pattern');
  });
});

describe('formatOutputContract', () => {
  it('includes the schema as JSON in the contract', () => {
    const schema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
    const output = formatOutputContract({ schema });
    expect(output).toContain('## Output Format');
    expect(output).toContain('```json');
    expect(output).toContain('"name"');
  });

  it('includes schema name when provided', () => {
    const output = formatOutputContract({ schema: { type: 'object' }, name: 'Person' });
    expect(output).toContain('Schema name: Person');
  });
});

describe('parseAndValidateOutput', () => {
  it('parses valid JSON matching schema', () => {
    const result = parseAndValidateOutput<{ name: string }>('{"name": "Alice"}', {
      schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    });
    expect('value' in result).toBe(true);
    if ('value' in result) {
      expect(result.value).toEqual({ name: 'Alice' });
    }
  });

  it('returns error for invalid JSON', () => {
    const result = parseAndValidateOutput('not json', { schema: { type: 'object' } });
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.code).toBe('invalid_output');
      expect(result.error.message).toContain('parse');
    }
  });

  it('returns error for JSON that does not match schema', () => {
    const result = parseAndValidateOutput('{"name": 42}', {
      schema: { type: 'object', properties: { name: { type: 'string' } } },
    });
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.code).toBe('invalid_output');
      expect(result.error.message).toContain('does not match');
    }
  });
});
