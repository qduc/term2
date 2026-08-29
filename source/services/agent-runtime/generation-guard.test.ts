import { expect, it } from 'vitest';
import { GenerationGuard, GenerationGuardError } from './generation-guard.js';

it('accepts reasoning at the character cap and silently drops the excess rather than aborting', () => {
  const guard = new GenerationGuard({ maxReasoningCharacters: 5, maxOutputCharacters: 5 });

  expect(guard.observeReasoning('12345')).toBe('12345');
  expect(guard.observeReasoning('6')).toBe('');
  expect(guard.reasoningCharacters).toBe(5);
  expect(guard.outputCharacters).toBe(0);
});

it('forwards only the prefix that fits when a reasoning chunk straddles the cap', () => {
  const guard = new GenerationGuard({ maxReasoningCharacters: 5 });

  expect(guard.observeReasoning('123')).toBe('123');
  expect(guard.observeReasoning('456')).toBe('45');
  expect(guard.observeReasoning('789')).toBe('');
  expect(guard.reasoningCharacters).toBe(5);
});

it('does not spend the aggregate output budget on truncated reasoning, so later text can still settle', () => {
  const guard = new GenerationGuard({
    maxReasoningCharacters: 5,
    maxOutputCharacters: 5,
    maxTextCharacters: 5,
  });

  expect(guard.observeReasoning('123456')).toBe('12345');
  expect(() => guard.observeText('hello')).not.toThrow();
  expect(guard.textCharacters).toBe(5);
  expect(guard.outputCharacters).toBe(5);
});

it('does not reject a completion whose reasoning exceeds the cap', () => {
  const guard = new GenerationGuard({ maxReasoningCharacters: 5, maxOutputCharacters: 5 });

  expect(() => guard.observeCompletion([{ type: 'reasoning', text: '1234567890' }])).not.toThrow();
  expect(guard.reasoningCharacters).toBe(5);
});

it('allows periodic text beyond the former repetition threshold', () => {
  const text = 'fixed-width periodic model data\n'.repeat(200);
  const guard = new GenerationGuard();

  expect(text.length).toBeGreaterThan(4_096);
  expect(() => guard.observeText(text)).not.toThrow();
  expect(guard.textCharacters).toBe(text.length);
});

it('still aborts when visible text exceeds its cap', () => {
  const guard = new GenerationGuard({ maxTextCharacters: 5 });

  expect(() => guard.observeText('123456')).toThrow(GenerationGuardError);
  try {
    guard.observeText('123456');
  } catch (error) {
    expect(error).toMatchObject({ code: 'text_characters', unsafeToReplay: true });
  }
});

it('keeps the default 100,000-character aggregate output containment settlement', () => {
  const guard = new GenerationGuard();

  guard.observeText('x'.repeat(100_000));
  expect(() => guard.observeToolArgumentProgress(1)).toThrow(GenerationGuardError);
  try {
    guard.observeToolArgumentProgress(1);
  } catch (error) {
    expect(error).toMatchObject({ code: 'output_characters', unsafeToReplay: true });
  }
});
