import { connect } from 'node:net';
import { once } from 'node:events';
import path from 'node:path';
import { CONTROL_PROTOCOL_VERSION, listControlAdvertisements } from './control-socket.js';

interface Output {
  write(text: string): unknown;
}

async function call(socketPath: string, method: string, params?: unknown): Promise<any> {
  const socket = connect(socketPath);
  try {
    await once(socket, 'connect');
    const read = async () => {
      let buffered = '';
      while (!buffered.includes('\n')) {
        const [chunk] = (await once(socket, 'data')) as [Buffer];
        buffered += chunk.toString('utf8');
      }
      const line = buffered.slice(0, buffered.indexOf('\n'));
      return JSON.parse(line);
    };
    socket.write(`${JSON.stringify({ v: CONTROL_PROTOCOL_VERSION, id: 'hello', method: 'hello' })}\n`);
    const hello = await read();
    if (!hello.ok) return hello;
    socket.write(
      `${JSON.stringify({ v: CONTROL_PROTOCOL_VERSION, id: 'call', method, ...(params ? { params } : {}) })}\n`,
    );
    return await read();
  } finally {
    socket.destroy();
  }
}

function outputResult(output: Output, result: unknown, json: boolean): void {
  output.write(
    json
      ? `${JSON.stringify(result)}\n`
      : `${Object.entries(result as Record<string, unknown>)
          .map(([key, value]) => `${key}=${value && typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
          .join(' ')}\n`,
  );
}

export async function runControlCommand(
  argv: string[],
  stdout: Output,
  stderr: Output,
  stdin: AsyncIterable<Buffer | string> = process.stdin,
): Promise<number> {
  try {
    return await runControlCommandImpl(argv, stdout, stderr, stdin);
  } catch (error) {
    stderr.write(`Control command failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function runControlCommandImpl(
  argv: string[],
  stdout: Output,
  stderr: Output,
  stdin: AsyncIterable<Buffer | string>,
): Promise<number> {
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (!runtimeDir || !path.isAbsolute(runtimeDir)) {
    stderr.write('Error: XDG_RUNTIME_DIR must be present and absolute.\n');
    return 1;
  }
  const [subcommand, ...rest] = argv;
  if (subcommand === 'list') {
    const status = rest.includes('--status');
    const ads = listControlAdvertisements(runtimeDir);
    for (const ad of ads) {
      const value: Record<string, unknown> = { ...ad };
      if (status) {
        const response = await call(ad.socketPath, 'status');
        if (response.ok) Object.assign(value, response.result);
        else value.error = response.error?.code ?? 'unavailable';
      }
      stdout.write(`${JSON.stringify(value)}\n`);
    }
    return 0;
  }
  const json = rest.includes('--json');
  const positional = rest.filter(
    (arg, index) =>
      arg !== '--json' &&
      !['--id', '--message-id', '--timeout'].includes(arg) &&
      !['--id', '--message-id', '--timeout'].includes(rest[index - 1] ?? ''),
  );
  const name = positional[0];
  const advertisement = name && listControlAdvertisements(runtimeDir).find((item) => item.name === name);
  if (!advertisement) {
    stderr.write(`Error: no live control socket named ${name ?? ''}.\n`);
    return 1;
  }
  if (subcommand === 'status' && positional.length === 1) {
    const response = await call(advertisement.socketPath, 'status');
    if (!response.ok) {
      stderr.write(`${response.error?.message ?? response.error?.code ?? 'Control request failed'}\n`);
      return 1;
    }
    outputResult(stdout, response.result, json);
    return 0;
  }
  if (subcommand === 'get' && positional.length === 2) {
    const response = await call(advertisement.socketPath, 'get', { topic: positional[1] });
    if (!response.ok) {
      stderr.write(`${response.error?.message ?? response.error?.code ?? 'Control request failed'}\n`);
      return 1;
    }
    outputResult(stdout, response.result, json);
    return 0;
  }
  if (subcommand === 'submit' || subcommand === 'steer') {
    const idIndex = rest.indexOf('--id');
    const requestId = idIndex >= 0 ? rest[idIndex + 1] : undefined;
    if (!requestId || !/^[A-Za-z0-9_-]{1,256}$/.test(requestId) || positional.length !== 1) return 1;
    let text = '';
    for await (const chunk of stdin) text += chunk.toString();
    if (text.length === 0) {
      stderr.write('Error: stdin must contain a non-empty message.\n');
      return 1;
    }
    const response = await call(advertisement.socketPath, subcommand, { text, clientRequestId: requestId });
    if (!response.ok) {
      stderr.write(`${response.error?.message ?? response.error?.code ?? 'Control request failed'}\n`);
      return 1;
    }
    outputResult(stdout, response.result, json);
    return 0;
  }
  if (subcommand === 'interrupt' && positional.length === 1) {
    const response = await call(advertisement.socketPath, 'interrupt');
    if (!response.ok) {
      stderr.write(`${response.error?.message ?? response.error?.code ?? 'Control request failed'}\n`);
      return 1;
    }
    outputResult(stdout, response.result, json);
    return 0;
  }
  if (subcommand === 'wait-turn') {
    const messageIndex = rest.indexOf('--message-id');
    const messageId = messageIndex >= 0 ? rest[messageIndex + 1] : undefined;
    const timeoutIndex = rest.indexOf('--timeout');
    const timeoutSeconds = timeoutIndex >= 0 ? Number(rest[timeoutIndex + 1]) : 600;
    if (!messageId || !Number.isFinite(timeoutSeconds) || timeoutSeconds < 0 || positional.length !== 1) return 1;
    const deadline = Date.now() + timeoutSeconds * 1000;
    let firstPoll = true;
    while (firstPoll || Date.now() <= deadline) {
      firstPoll = false;
      const response = await call(advertisement.socketPath, 'status');
      if (!response.ok) {
        stderr.write(`${response.error?.message ?? response.error?.code ?? 'Control request failed'}\n`);
        return 1;
      }
      const result = response.result;
      if (result.phase === 'awaiting_approval') {
        outputResult(stdout, { status: 'awaiting_approval', messageId }, json);
        return 3;
      }
      const queued = Array.isArray(result.queue) && result.queue.some((item: any) => item.id === messageId);
      if (result.phase === 'idle' && !queued) {
        outputResult(stdout, { status: 'complete', messageId }, json);
        return 0;
      }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    outputResult(stdout, { status: 'timeout', messageId }, json);
    return 2;
  }
  stderr.write(
    'Usage: term2 control list [--status] | status <name> [--json] | get <name> <topic> [--json] | submit|steer <name> --id <id> | interrupt <name> | wait-turn <name> --message-id <id>\n',
  );
  return 1;
}
