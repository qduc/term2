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
          .map(([key, value]) => `${key}=${String(value)}`)
          .join(' ')}\n`,
  );
}

export async function runControlCommand(argv: string[], stdout: Output, stderr: Output): Promise<number> {
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
  const positional = rest.filter((arg) => arg !== '--json');
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
  stderr.write('Usage: term2 control list [--status] | status <name> [--json] | get <name> <topic> [--json]\n');
  return 1;
}
