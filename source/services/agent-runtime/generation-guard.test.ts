import { afterEach, expect, it, vi } from 'vitest';
import { GenerationGuard, GenerationGuardError, ToolArgumentRunawayGuard } from './generation-guard.js';

afterEach(() => {
  vi.useRealTimers();
});

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

it('uses the approved 60-second Luna unfinished-tool-call window', () => {
  expect(new GenerationGuard().toolArgumentRunawayMs).toBe(60_000);
});

it('aborts one continuously incomplete tiny-delta tool call at its runaway deadline', async () => {
  vi.useFakeTimers();
  const abort = vi.fn();
  const guard = new ToolArgumentRunawayGuard(
    { timeoutMs: 1_000, minDeltaFramesPerSecond: 4, maxAverageCharsPerFrame: 3, maxInterDeltaMs: 300 },
    abort,
  );
  const pending = guard.wait(new Promise<never>(() => undefined));
  const rejection = expect(pending).rejects.toMatchObject({
    code: 'tool_argument_runaway',
    unsafeToReplay: true,
    message: expect.stringContaining('5 argument deltas'),
  });

  guard.observeToolArgumentProgress(1);
  for (let count = 2; count <= 5; count++) {
    await vi.advanceTimersByTimeAsync(200);
    guard.observeToolArgumentProgress(count);
  }
  await vi.advanceTimersByTimeAsync(199);
  expect(abort).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);

  await rejection;
  expect(abort).toHaveBeenCalledOnce();
  guard.dispose();
});

it('does not abort a slow valid tool call that lacks the tiny-delta runaway signature', async () => {
  vi.useFakeTimers();
  const abort = vi.fn();
  const guard = new ToolArgumentRunawayGuard(
    { timeoutMs: 1_000, minDeltaFramesPerSecond: 4, maxAverageCharsPerFrame: 3, maxInterDeltaMs: 300 },
    abort,
  );

  guard.observeToolArgumentProgress(500);
  await vi.advanceTimersByTimeAsync(1_000);

  expect(abort).not.toHaveBeenCalled();
  guard.observeToolCallCompleted();
  guard.dispose();
});

it('disarms the tool-argument runaway timer when assistant text or a second call appears', async () => {
  vi.useFakeTimers();
  const textAbort = vi.fn();
  const textGuard = new ToolArgumentRunawayGuard(
    { timeoutMs: 100, minDeltaFramesPerSecond: 1, maxAverageCharsPerFrame: 3, maxInterDeltaMs: 100 },
    textAbort,
  );
  textGuard.observeToolArgumentProgress(1);
  textGuard.observeText();

  const secondCallAbort = vi.fn();
  const secondCallGuard = new ToolArgumentRunawayGuard(
    { timeoutMs: 100, minDeltaFramesPerSecond: 1, maxAverageCharsPerFrame: 3, maxInterDeltaMs: 100 },
    secondCallAbort,
  );
  secondCallGuard.observeToolArgumentProgress(2);
  secondCallGuard.observeToolArgumentProgress(1);

  await vi.advanceTimersByTimeAsync(100);

  expect(textAbort).not.toHaveBeenCalled();
  expect(secondCallAbort).not.toHaveBeenCalled();
  textGuard.dispose();
  secondCallGuard.dispose();
});

it('disarms rather than aborting on malformed cumulative argument progress', async () => {
  vi.useFakeTimers();
  const abort = vi.fn();
  const guard = new ToolArgumentRunawayGuard(
    { timeoutMs: 100, minDeltaFramesPerSecond: 1, maxAverageCharsPerFrame: 3, maxInterDeltaMs: 100 },
    abort,
  );
  guard.observeToolArgumentProgress(Number.NaN);
  guard.observeToolArgumentProgress(1);

  await vi.advanceTimersByTimeAsync(100);

  expect(abort).not.toHaveBeenCalled();
  guard.dispose();
});
