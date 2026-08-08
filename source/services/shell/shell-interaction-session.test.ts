import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShellInteractionSession } from './shell-interaction-session.js';

const mocks = vi.hoisted(() => ({
  executeFormattedShellCommand: vi.fn(),
}));

vi.mock('../../utils/shell/shell-session.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/shell/shell-session.js')>()),
  executeFormattedShellCommand: (...args: unknown[]) => mocks.executeFormattedShellCommand(...args),
}));

const createSession = (
  options: {
    liteMode?: boolean;
    sshInfo?: { host: string; user: string; remoteDir: string };
    sshService?: object;
  } = {},
) => {
  const addShellContext = vi.fn();
  const settingsService = { get: vi.fn(() => undefined) };
  const session = new ShellInteractionSession({
    settingsService: settingsService as any,
    conversationSink: { addShellContext },
    liteMode: options.liteMode ?? true,
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
  it('only enters shell mode while lite mode is eligible', () => {
    const { session } = createSession({ liteMode: false });

    session.toggleShellMode();

    expect(session.getSnapshot()).toEqual({ isShellMode: false });
    expect(session.submit('pwd')).toBeNull();
  });

  it('executes accepted commands, forwards SSH execution, and retains their history', async () => {
    const sshService = {};
    const { session } = createSession({
      sshInfo: { host: 'example.test', user: 'agent', remoteDir: '/remote/project' },
      sshService,
    });
    session.toggleShellMode();

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
    session.toggleShellMode();

    expect(session.submit('   ')).toBeNull();

    expect(mocks.executeFormattedShellCommand).not.toHaveBeenCalled();
  });

  it('flushes a completed shell history only once when shell mode closes', async () => {
    const { session, addShellContext } = createSession();
    session.toggleShellMode();
    await session.submit('echo one')!.completion;

    session.toggleShellMode();
    session.flushShellHistory();

    expect(addShellContext).toHaveBeenCalledOnce();
    expect(addShellContext).toHaveBeenCalledWith(expect.stringContaining('$ echo one'));
  });

  it('exits and flushes when lite mode is disabled', async () => {
    const { session, addShellContext } = createSession();
    session.toggleShellMode();
    await session.submit('echo two')!.completion;

    session.setLiteMode(false);

    expect(session.getSnapshot()).toEqual({ isShellMode: false });
    expect(addShellContext).toHaveBeenCalledWith(expect.stringContaining('$ echo two'));
  });
});
