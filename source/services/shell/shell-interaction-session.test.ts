import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShellInteractionSession } from './shell-interaction-session.js';

const mocks = vi.hoisted(() => ({
  executeFormattedShellCommand: vi.fn(),
}));

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

vi.mock('../../utils/shell/shell-session.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/shell/shell-session.js')>()),
  executeFormattedShellCommand: (...args: unknown[]) => mocks.executeFormattedShellCommand(...args),
}));

const createSession = (
  options: {
    sshInfo?: { host: string; user: string; remoteDir: string };
    sshService?: object;
  } = {},
) => {
  const addShellContext = vi.fn();
  const settingsService = { get: vi.fn(() => undefined) };
  const session = new ShellInteractionSession({
    settingsService: settingsService as any,
    conversationSink: { addShellContext },
    sshInfo: options.sshInfo,
    sshService: options.sshService as any,
  });
  return { session, addShellContext, settingsService };
};

beforeEach(() => {
  mocks.executeFormattedShellCommand.mockReset();
  mocks.executeFormattedShellCommand.mockResolvedValue({ text: 'command output', exitCode: 0, timedOut: false });
});

describe('ShellInteractionSession', () => {
  it('enters shell mode regardless of the application mode', () => {
    const { session } = createSession();

    session.enterShellMode();

    expect(session.getSnapshot()).toEqual({ isShellMode: true });
    expect(session.submit('pwd')).not.toBeNull();
  });

  it('executes accepted commands, forwards SSH execution, and retains their history', async () => {
    const sshService = {};
    const { session } = createSession({
      sshInfo: { host: 'example.test', user: 'agent', remoteDir: '/remote/project' },
      sshService,
    });
    session.enterShellMode();

    const submission = session.submit('  pwd  ');
    expect(submission).toMatchObject({ command: 'pwd' });
    const result = await submission!.completion;

    expect(mocks.executeFormattedShellCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'pwd',
        sshInfo: { host: 'example.test', user: 'agent', remoteDir: '/remote/project' },
        sshService,
      }),
    );
    expect(result).toEqual({ command: 'pwd', output: 'command output', exitCode: 0, timedOut: false });
  });

  it('does not admit or execute whitespace-only input', () => {
    const { session } = createSession();
    session.enterShellMode();

    expect(session.submit('   ')).toBeNull();

    expect(mocks.executeFormattedShellCommand).not.toHaveBeenCalled();
  });

  it('flushes a completed shell history only once when shell mode closes', async () => {
    const { session, addShellContext } = createSession();
    session.enterShellMode();
    await session.submit('echo one')!.completion;

    session.exitShellMode();
    session.flushShellHistory();

    expect(addShellContext).toHaveBeenCalledOnce();
    expect(addShellContext).toHaveBeenCalledWith(expect.stringContaining('$ echo one'));
  });

  it('flushes a command that completes after shell mode closes', async () => {
    const completion = deferred<{ text: string; exitCode: number | null; timedOut: boolean }>();
    mocks.executeFormattedShellCommand.mockReturnValueOnce(completion.promise);
    const { session, addShellContext } = createSession();
    session.enterShellMode();
    const submission = session.submit('echo delayed')!;

    session.exitShellMode();

    expect(addShellContext).not.toHaveBeenCalled();
    completion.resolve({ text: 'delayed output', exitCode: 0, timedOut: false });
    await submission.completion;
    expect(addShellContext).toHaveBeenCalledOnce();
    expect(addShellContext).toHaveBeenCalledWith(expect.stringContaining('$ echo delayed'));
  });

  it('waits for every accepted command before flushing one complete context block', async () => {
    const firstCompletion = deferred<{ text: string; exitCode: number | null; timedOut: boolean }>();
    const secondCompletion = deferred<{ text: string; exitCode: number | null; timedOut: boolean }>();
    mocks.executeFormattedShellCommand
      .mockReturnValueOnce(firstCompletion.promise)
      .mockReturnValueOnce(secondCompletion.promise);
    const { session, addShellContext } = createSession();
    session.enterShellMode();
    const first = session.submit('echo first')!;
    const second = session.submit('echo second')!;

    session.exitShellMode();
    secondCompletion.resolve({ text: 'second output', exitCode: 0, timedOut: false });
    await second.completion;
    expect(addShellContext).not.toHaveBeenCalled();

    firstCompletion.resolve({ text: 'first output', exitCode: 0, timedOut: false });
    await first.completion;
    expect(addShellContext).toHaveBeenCalledOnce();
    expect(addShellContext.mock.calls[0]?.[0]).toContain('$ echo first');
    expect(addShellContext.mock.calls[0]?.[0]).toContain('$ echo second');
  });

  it('does not let a failed execution strand another completed command', async () => {
    const successfulCompletion = deferred<{ text: string; exitCode: number | null; timedOut: boolean }>();
    const failedCompletion = deferred<{ text: string; exitCode: number | null; timedOut: boolean }>();
    mocks.executeFormattedShellCommand
      .mockReturnValueOnce(successfulCompletion.promise)
      .mockReturnValueOnce(failedCompletion.promise);
    const { session, addShellContext } = createSession();
    session.enterShellMode();
    const successful = session.submit('echo kept')!;
    const failed = session.submit('echo failed')!;

    session.exitShellMode();
    failedCompletion.reject(new Error('execution failed'));
    await expect(failed.completion).rejects.toThrow('execution failed');
    expect(addShellContext).not.toHaveBeenCalled();

    successfulCompletion.resolve({ text: 'kept output', exitCode: 0, timedOut: false });
    await successful.completion;
    expect(addShellContext).toHaveBeenCalledOnce();
    expect(addShellContext).toHaveBeenCalledWith(expect.stringContaining('$ echo kept'));
  });

  it('exits and flushes when shell mode is left', async () => {
    const { session, addShellContext } = createSession();
    session.enterShellMode();
    await session.submit('echo two')!.completion;

    session.exitShellMode();

    expect(session.getSnapshot()).toEqual({ isShellMode: false });
    expect(addShellContext).toHaveBeenCalledWith(expect.stringContaining('$ echo two'));
  });
});
