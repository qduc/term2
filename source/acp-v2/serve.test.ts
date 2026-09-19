import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as acp from '@agentclientprotocol/sdk/experimental/v2';
import { parseAcpArgs } from './serve-args.js';
import { runAcp, type AcpServeIo } from './serve.js';
import { registerProvider, unregisterProvider, type ProviderDefinition } from '../providers/registry.js';

const providerId = 'acp-m2-unit-provider';
const modelId = 'acp-m2-unit-model';

const provider: ProviderDefinition = {
  id: providerId,
  label: 'ACP M2 unit provider',
  fetchModels: async () => [{ id: modelId }],
  createStreamedModel: () => ({
    stream: async function* () {
      yield { type: 'text_delta' as const, text: 'hello from acp' };
      yield {
        type: 'completion' as const,
        responseId: 'acp-m2-completion',
        output: [{ type: 'message' as const, content: [{ type: 'text' as const, text: 'hello from acp' }] }],
      };
    },
  }),
};

const packageVersion: string = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

const tempRoots: string[] = [];
const savedEnv = new Map<string, string | undefined>();

/** Point the launcher's ambient state at a temp tree, restoring it afterwards. */
const isolateEnv = (values: Record<string, string>): void => {
  for (const [key, value] of Object.entries(values)) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
};

afterEach(() => {
  unregisterProvider(providerId);
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Recording stdio double: every byte the launcher writes to stdout is captured. */
const createHarness = () => {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  const agentInputWriter = clientToAgent.writable.getWriter();
  const agentOutputWriter = agentToClient.writable.getWriter();
  const stdoutChunks: string[] = [];
  const stderrLines: string[] = [];
  const io: AcpServeIo = {
    stdin: clientToAgent.readable,
    stdout: new WritableStream<Uint8Array>({
      write: async (chunk) => {
        stdoutChunks.push(Buffer.from(chunk).toString('utf8'));
        await agentOutputWriter.write(chunk);
      },
    }),
    writeStderr: (message) => {
      stderrLines.push(message);
    },
  };
  return {
    io,
    agentToClient,
    stdoutChunks,
    stderrLines,
    // What the client writes into: closing it is the stdin EOF the launcher sees.
    clientOutput: new WritableStream<Uint8Array>({
      write: (chunk) => agentInputWriter.write(chunk),
    }),
    stdoutText: () => stdoutChunks.join(''),
    endStdin: () => agentInputWriter.close(),
  };
};

/** An io whose streams are never touched, for paths that fail before transport. */
const inertIo = () => {
  const stdoutChunks: string[] = [];
  const stderrLines: string[] = [];
  const io: AcpServeIo = {
    stdin: new ReadableStream<Uint8Array>(),
    stdout: new WritableStream<Uint8Array>({
      write: (chunk) => {
        stdoutChunks.push(Buffer.from(chunk).toString('utf8'));
      },
    }),
    writeStderr: (message) => {
      stderrLines.push(message);
    },
  };
  return { io, stdoutChunks, stderrLines };
};

describe('parseAcpArgs', () => {
  it('accepts no flags and each supported flag', () => {
    expect(parseAcpArgs([])).toEqual({ ok: true, args: {} });
    expect(parseAcpArgs(['--provider', 'openai'])).toEqual({ ok: true, args: { provider: 'openai' } });
    expect(parseAcpArgs(['--model', 'gpt-5.4'])).toEqual({ ok: true, args: { model: 'gpt-5.4' } });
    expect(parseAcpArgs(['--effort', 'high'])).toEqual({ ok: true, args: { effort: 'high' } });
    expect(parseAcpArgs(['--provider', 'openai', '--model', 'openai/gpt-5.4', '--effort', 'low'])).toEqual({
      ok: true,
      args: { provider: 'openai', model: 'openai/gpt-5.4', effort: 'low' },
    });
  });

  it('rejects a flag without a value instead of swallowing the next flag', () => {
    expect(parseAcpArgs(['--model'])).toEqual({ ok: false, error: '--model requires a value' });
    expect(parseAcpArgs(['--provider', '--model', 'gpt-5.4'])).toEqual({
      ok: false,
      error: '--provider requires a value',
    });
  });

  it('rejects an invalid effort rather than passing it through', () => {
    const result = parseAcpArgs(['--effort', 'turbo']);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toContain('--effort must be one of:');
  });

  it('rejects unknown options, positional arguments, and the CLI auto-approve flag', () => {
    expect(parseAcpArgs(['--auto-approve'])).toEqual({ ok: false, error: 'unknown option "--auto-approve"' });
    expect(parseAcpArgs(['--allow-write'])).toEqual({ ok: false, error: 'unknown option "--allow-write"' });
    expect(parseAcpArgs(['prompt text'])).toEqual({ ok: false, error: 'unexpected argument "prompt text"' });
  });
});

describe('runAcp', () => {
  it('reports a startup failure on stderr and writes nothing to stdout', async () => {
    const unknownProvider = inertIo();
    await expect(runAcp(['--provider', 'not-a-real-provider'], unknownProvider.io)).resolves.toBe(1);
    expect(unknownProvider.stderrLines.join('\n')).toContain('term2 acp: unknown provider "not-a-real-provider".');
    expect(unknownProvider.stdoutChunks).toEqual([]);

    const rejectedFlag = inertIo();
    await expect(runAcp(['--auto-approve'], rejectedFlag.io)).resolves.toBe(1);
    expect(rejectedFlag.stderrLines.join('\n')).toContain('term2 acp: unknown option "--auto-approve"');
    expect(rejectedFlag.stdoutChunks).toEqual([]);
  });

  it('serves initialize, session/new and a prompt over stdio, then flushes and closes on EOF', async () => {
    registerProvider(provider);
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'acp-m2-unit-')));
    tempRoots.push(root);
    const workspace = path.join(root, 'workspace');
    const conversations = path.join(root, 'conversations');
    const settingsDir = path.join(root, 'state', 'term2-nodejs');
    mkdirSync(workspace);
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({ agent: { provider: providerId, model: modelId, retryAttempts: 0 } }),
      'utf8',
    );
    isolateEnv({
      XDG_STATE_HOME: path.join(root, 'state'),
      TERM2_CONVERSATIONS_DIR: conversations,
      TERM2_TEST_DB_DIR: conversations,
      DISABLE_LOGGING: '1',
    });

    const harness = createHarness();
    const runPromise = runAcp([], harness.io);
    const updates: acp.UpdateSessionNotification[] = [];
    const client = acp
      .client({ name: 'acp-m2-unit-client' })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        updates.push(params);
      });

    let sessionId = '';
    await client.connectWith(
      acp.ndJsonStream(harness.clientOutput, harness.agentToClient.readable),
      async (context) => {
        const initialized = await context.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          info: { name: 'acp-m2-unit-client', version: '1.0.0' },
        });
        expect(initialized.info.version).toBe(packageVersion);

        const created = await context.request(acp.methods.agent.session.new, { cwd: workspace });
        sessionId = created.sessionId;

        await context.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: 'hello' }],
        });
        await vi.waitFor(() => {
          expect(updates).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ update: { sessionUpdate: 'state_update', state: 'running' } }),
              expect.objectContaining({ update: expect.objectContaining({ sessionUpdate: 'agent_message_chunk' }) }),
              expect.objectContaining({
                update: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' },
              }),
            ]),
          );
        });
      },
    );

    // The session is still live: closing it is the shutdown's job, so this is
    // what proves EOF (not an explicit session/close) flushes the writer.
    expect(existsSync(path.join(conversations, `${sessionId}.lock`))).toBe(true);
    await harness.endStdin();

    await expect(runPromise).resolves.toBe(0);

    expect(existsSync(path.join(conversations, `${sessionId}.jsonl`))).toBe(true);
    expect(existsSync(path.join(conversations, `${sessionId}.lock`))).toBe(false);

    // stdout is the protocol channel: every line must be a JSON-RPC frame.
    const lines = harness
      .stdoutText()
      .split('\n')
      .filter((line) => line.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(JSON.parse(line), line).toMatchObject({ jsonrpc: '2.0' });
    }
  }, 30_000);

  it('restores the signal listeners it parks for the duration of the run', async () => {
    registerProvider(provider);
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'acp-m2-signals-')));
    tempRoots.push(root);
    const workspace = path.join(root, 'workspace');
    const conversations = path.join(root, 'conversations');
    const settingsDir = path.join(root, 'state', 'term2-nodejs');
    mkdirSync(workspace);
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({ agent: { provider: providerId, model: modelId, retryAttempts: 0 } }),
      'utf8',
    );
    isolateEnv({
      XDG_STATE_HOME: path.join(root, 'state'),
      TERM2_CONVERSATIONS_DIR: conversations,
      TERM2_TEST_DB_DIR: conversations,
      DISABLE_LOGGING: '1',
    });

    // A listener this launcher does not own — a test host's, or an
    // instrumenting module's — must be back in place once the run returns.
    const parked = vi.fn();
    process.on('SIGINT', parked);
    const listenersBefore = process.listeners('SIGINT');
    try {
      const harness = createHarness();
      const runPromise = runAcp([], harness.io);
      await harness.endStdin();
      await expect(runPromise).resolves.toBe(0);

      expect(process.listeners('SIGINT')).toContain(parked);
      expect(process.listeners('SIGINT')).toEqual(listenersBefore);
    } finally {
      process.removeListener('SIGINT', parked);
    }
  }, 30_000);
});
