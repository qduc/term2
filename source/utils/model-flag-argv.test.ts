import { describe, expect, it } from 'vitest';
import { preprocessArgvForOptionalModelFlag } from './model-flag-argv.js';

describe('preprocessArgvForOptionalModelFlag', () => {
  it('makes -m valueless when followed by exactly one trailing token, leaving that token positional', () => {
    // '-m "explain this"' with nothing else: the token becomes a bare
    // positional prompt, not the model's value.
    expect(preprocessArgvForOptionalModelFlag(['-m', 'explain this'])).toEqual(['-m', '', 'explain this']);
  });

  it('applies the same rule to the long flag form', () => {
    expect(preprocessArgvForOptionalModelFlag(['--model', 'explain this'])).toEqual(['--model', '', 'explain this']);
  });

  it('does not touch --model followed by two or more trailing tokens (value, then prompt)', () => {
    expect(preprocessArgvForOptionalModelFlag(['--model', 'gpt-5.4', 'explain this'])).toEqual([
      '--model',
      'gpt-5.4',
      'explain this',
    ]);
  });

  it('does not touch a bare --model at the end of argv', () => {
    expect(preprocessArgvForOptionalModelFlag(['--model'])).toEqual(['--model']);
  });

  it('does not touch --model immediately followed by another flag', () => {
    expect(preprocessArgvForOptionalModelFlag(['--model', '--provider', 'openai'])).toEqual([
      '--model',
      '--provider',
      'openai',
    ]);
  });

  it('does not touch --model=value (equals form is always unambiguous)', () => {
    expect(preprocessArgvForOptionalModelFlag(['--model=gpt-5.4'])).toEqual(['--model=gpt-5.4']);
  });

  it('does not touch -m=value (equals form is always unambiguous)', () => {
    expect(preprocessArgvForOptionalModelFlag(['-m=gpt-5.4'])).toEqual(['-m=gpt-5.4']);
  });

  it('does not touch a value that itself looks like a flag (left for meow to reject/handle)', () => {
    expect(preprocessArgvForOptionalModelFlag(['--model', '-p'])).toEqual(['--model', '-p']);
  });

  it('leaves argv without --model/-m completely untouched', () => {
    expect(preprocessArgvForOptionalModelFlag(['explain this', '--auto-approve'])).toEqual([
      'explain this',
      '--auto-approve',
    ]);
  });

  it('handles --model as the very first and only argv token', () => {
    expect(preprocessArgvForOptionalModelFlag(['--model'])).toEqual(['--model']);
  });

  it('does not double-count when --provider precedes the ambiguous --model', () => {
    expect(preprocessArgvForOptionalModelFlag(['--provider', 'openai', '--model', 'explain this'])).toEqual([
      '--provider',
      'openai',
      '--model',
      '',
      'explain this',
    ]);
  });
});
