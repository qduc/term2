// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerProvider, unregisterProvider } from '../../providers/index.js';
import { createMockSettingsService } from '../settings/settings-service.mock.js';
import { clearModelCache } from '../model-service.js';
import { isModelPickerEligible, isModelPickerHostSupported, runModelPickerHost } from './model-picker-host.js';

const noopLoggingService = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  setCorrelationId: () => {},
  getCorrelationId: () => undefined,
  clearCorrelationId: () => {},
} as any;

/**
 * A minimal TTY-shaped stdin: real enough for Ink's App component to enable
 * and disable raw mode, register/unregister its 'readable' listener, and
 * decode bytes through the normal (non-debug) input path — with spies on the
 * calls this test asserts teardown through.
 */
class FakeStdin extends EventEmitter {
  isTTY = true;
  setRawModeCalls: boolean[] = [];
  refCalls = 0;
  unrefCalls = 0;
  private pending: string | null = null;

  setRawMode(mode: boolean) {
    this.setRawModeCalls.push(mode);
  }

  setEncoding() {}
  resume() {}
  pause() {}
  ref() {
    this.refCalls++;
  }
  unref() {
    this.unrefCalls++;
  }

  write(chunk: string) {
    this.pending = chunk;
    this.emit('readable');
  }

  read(): string | null {
    const value = this.pending;
    this.pending = null;
    return value;
  }
}

class FakeStdout extends EventEmitter {
  isTTY = true;
  columns = 100;
  rows = 40;
  frames: string[] = [];
  write = (frame: string) => {
    this.frames.push(frame);
    return true;
  };
}

// The real async work here (provider credential resolution, the mocked
// provider's fetchModels promise chain, Ink's own render loop on real
// timers) settles in a few hundred ms locally; a loaded CI runner gets a
// larger allowance rather than one fixed constant. vi.waitFor is vitest's
// own polling primitive (used the same way elsewhere in this repo, e.g.
// app.nested-approval-hide.test.tsx) rather than a bespoke setTimeout loop.
//
// Exceeding this budget under CI is not by itself evidence of runner
// contention: it is also exactly what a non-interactive Ink render looks
// like, because Ink writes no frame at all while mounted. Check
// runModelPickerHost's `interactive: true` before blaming the runner.
const DEFAULT_WAIT_TIMEOUT_MS = process.env.CI ? 10000 : 2000;

const waitFor = (predicate: () => boolean, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS): Promise<void> =>
  vi.waitFor(
    () => {
      if (!predicate()) throw new Error('waitFor: condition not met within timeout');
    },
    { timeout: timeoutMs, interval: 5 },
  );

describe('isModelPickerHostSupported', () => {
  it('requires both stdin and stdout to be a TTY', () => {
    expect(isModelPickerHostSupported({ stdin: { isTTY: true }, stdout: { isTTY: true } })).toBe(true);
    expect(isModelPickerHostSupported({ stdin: { isTTY: false }, stdout: { isTTY: true } })).toBe(false);
    expect(isModelPickerHostSupported({ stdin: { isTTY: true }, stdout: { isTTY: false } })).toBe(false);
    expect(isModelPickerHostSupported({ stdin: {}, stdout: {} })).toBe(false);
  });

  it('defaults to process.stdin/process.stdout when streams are omitted', () => {
    expect(isModelPickerHostSupported()).toBe(Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY));
  });
});

describe('isModelPickerEligible', () => {
  const tty = { isTTY: true };
  const baseline = { stdin: tty, stdout: tty, hasPositionalPrompt: false, json: false, harnessIdle: false };

  it('is true only when every guard passes', () => {
    expect(isModelPickerEligible(baseline)).toBe(true);
  });

  it('is false without a TTY on either stream', () => {
    expect(isModelPickerEligible({ ...baseline, stdin: { isTTY: false } })).toBe(false);
    expect(isModelPickerEligible({ ...baseline, stdout: { isTTY: false } })).toBe(false);
  });

  it('is false for a positional (non-interactive) prompt run', () => {
    expect(isModelPickerEligible({ ...baseline, hasPositionalPrompt: true })).toBe(false);
  });

  it('is false under --json', () => {
    expect(isModelPickerEligible({ ...baseline, json: true })).toBe(false);
  });

  it('is false under the isolated-harness marker', () => {
    expect(isModelPickerEligible({ ...baseline, harnessIdle: true })).toBe(false);
  });
});

describe('runModelPickerHost', () => {
  let providerId: string;

  beforeEach(() => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    clearModelCache();
    providerId = `host-test-provider-${Date.now()}-${Math.random()}`;
    registerProvider({
      id: providerId,
      label: 'Host Test Provider',
      fetchModels: async () => [{ id: 'gpt-test', name: 'GPT Test' }],
    });
  });

  afterEach(() => {
    unregisterProvider(providerId);
    vi.unstubAllEnvs();
  });

  it('never mounts without a TTY and returns cancelled immediately', async () => {
    const stdin = new FakeStdin();
    stdin.isTTY = false;
    const stdout = new FakeStdout();
    const settingsService = createMockSettingsService({ 'agent.provider': providerId });

    const result = await runModelPickerHost({
      settingsService,
      loggingService: noopLoggingService,
      stdin: stdin as any,
      stdout: stdout as any,
    });

    expect(result).toEqual({ status: 'cancelled' });
    expect(stdout.frames.length).toBe(0);
    expect(stdin.setRawModeCalls.length).toBe(0);
  });

  it('mounts, resolves a selection on Enter, and leaves the terminal clean on exit', async () => {
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const stderr = new FakeStdout();
    const settingsService = createMockSettingsService({ 'agent.provider': providerId });

    const resultPromise = runModelPickerHost({
      settingsService,
      loggingService: noopLoggingService,
      stdin: stdin as any,
      stdout: stdout as any,
      stderr: stderr as any,
    });

    await waitFor(() => stdout.frames.some((frame) => frame.includes('gpt-test')));
    expect(stdin.setRawModeCalls).toContain(true);

    stdin.write('\r');

    const result = await resultPromise;

    expect(result).toEqual({ status: 'selected', selection: { modelId: 'gpt-test', provider: providerId } });
    // Teardown left the terminal usable: raw mode was turned back off and no
    // stdin listener from this run is still attached.
    expect(stdin.setRawModeCalls.at(-1)).toBe(false);
    expect(stdin.listenerCount('readable')).toBe(0);
  });

  it('cancels on Escape and still restores the terminal', async () => {
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const settingsService = createMockSettingsService({ 'agent.provider': providerId });

    const resultPromise = runModelPickerHost({
      settingsService,
      loggingService: noopLoggingService,
      stdin: stdin as any,
      stdout: stdout as any,
      stderr: new FakeStdout() as any,
    });

    await waitFor(() => stdout.frames.some((frame) => frame.includes('gpt-test')));

    stdin.write('');
    // Ink buffers a lone Escape for ~20ms before flushing it as key.escape.
    await waitFor(() => stdin.setRawModeCalls.at(-1) === false);

    const result = await resultPromise;

    expect(result).toEqual({ status: 'cancelled' });
    expect(stdin.listenerCount('readable')).toBe(0);
  });

  it('seeds the initial query and lock-provider banner through to the mounted menu', async () => {
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const settingsService = createMockSettingsService({ 'agent.provider': providerId });

    const resultPromise = runModelPickerHost({
      settingsService,
      loggingService: noopLoggingService,
      stdin: stdin as any,
      stdout: stdout as any,
      stderr: new FakeStdout() as any,
      initialQuery: 'gpt',
      lockProvider: providerId,
      bannerLines: ['No models match "zzz".'],
    });

    await waitFor(
      () =>
        stdout.frames.some((frame) => frame.includes('No models match')) &&
        stdout.frames.some((frame) => frame.includes('gpt-test')),
    );

    stdin.write('');
    await waitFor(() => stdin.setRawModeCalls.at(-1) === false);
    await resultPromise;
  });
});
