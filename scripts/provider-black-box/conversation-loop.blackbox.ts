import { createServer, type ServerResponse } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createIsolatedWorkspaceLease, writePtyTextAndSubmit } from './provider-test-harness.js';

it('edits and retracts pending steering while one turn crosses two manual approvals, then handles release and cancellation without duplicate fallback', async () => {
  const requests: Record<string, unknown>[] = [];
  const pending: ServerResponse[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const part of request) body += String(part);
    requests.push(JSON.parse(body) as Record<string, unknown>);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(': fixture connection accepted\n\n');
    pending.push(response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture failed to bind');
  const lease = await createIsolatedWorkspaceLease({
    prefix: 'term2-readable-loop-',
    env: { OPENAI_BASE_URL: `http://127.0.0.1:${address.port}` },
    prepare: async (_root, paths) => {
      await mkdir(paths.logDir, { recursive: true });
      await writeFile(
        join(paths.logDir, 'settings.json'),
        JSON.stringify({
          agent: {
            modelSelection: { model: 'gpt-5.6-luna', provider: 'openai' },
            transport: 'http',
            retryAttempts: 0,
            openai: { apiKey: 'fixture' },
          },
          app: { liteMode: true },
          shell: { autoApproveMode: 'off' },
          sandbox: { enabled: true, allowNetworking: false },
        }),
      );
    },
  });
  const child = await lease.start({
    command: process.execPath,
    args: [
      process.env.TERM2_TEST_CLI ? resolve(process.env.TERM2_TEST_CLI) : join(process.cwd(), 'dist/cli.js'),
      '--lite',
    ],
    cwd: lease.root,
    cols: 120,
    rows: 40,
  });
  const complete = (index: number, output: Record<string, unknown>[]) => {
    const response = pending[index];
    if (!response) throw new Error(`Missing request ${index}`);
    const id = `loop-response-${index}`;
    for (const frame of [
      { type: 'response.created', response: { id, status: 'in_progress', output: [] } },
      { type: 'response.completed', response: { id, status: 'completed', output } },
    ])
      response.write(`data: ${JSON.stringify(frame)}\n\n`);
    response.end();
  };
  const call = (id: string) => ({
    id: `item-${id}`,
    type: 'function_call',
    status: 'completed',
    call_id: id,
    name: 'shell',
    arguments: JSON.stringify({ command: 'printf x >> approval-effects.txt', sandbox: 'unsandboxed' }),
  });
  const message = (text: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
  try {
    await child.waitForIdleInput();
    await writePtyTextAndSubmit(child, 'FIRST_LOOP_INPUT');
    await child.waitForState(() => requests.length === 1);
    await writePtyTextAndSubmit(child, 'ORIGINAL_STEER');
    await child.waitForComposerValue('');
    await child.waitForVisibleOutput('ORIGINAL_STEER');
    await child.write('\u001b[A');
    await child.waitForVisibleOutput('e edit');
    await child.write('e');
    await child.waitForComposerValue('ORIGINAL_STEER');
    for (let remaining = 'ORIGINAL_STEER'.length - 1; remaining >= 0; remaining--) {
      await child.write('\u007f');
      await child.waitForComposerValue('ORIGINAL_STEER'.slice(0, remaining));
    }
    await writePtyTextAndSubmit(child, 'EDITED_STEER');
    await child.waitForComposerValue('');
    await writePtyTextAndSubmit(child, 'RETRACTED_STEER');
    await child.waitForComposerValue('');
    const selectMarker = child.getOutput().length;
    await child.write('\u001b[A');
    await child.waitForState((s) => s.output.slice(selectMarker).includes('e edit'));
    const deleteMarker = child.getOutput().length;
    await child.write('d');
    await child.waitForState((s) => s.output.slice(deleteMarker).includes('select queued'));
    complete(0, [call('loop-first')]);
    await child.waitForVisibleOutput('Allow this action?');
    await expect(readFile(join(lease.root, 'approval-effects.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await child.write('y');
    await child.waitForState(() => requests.length === 2);
    const next = JSON.stringify(requests[1]);
    expect(next).toContain('EDITED_STEER');
    expect(next).not.toContain('ORIGINAL_STEER');
    expect(next).not.toContain('RETRACTED_STEER');
    expect(
      (requests[1]!.input as Record<string, unknown>[]).filter(
        (item) => item.type === 'function_call_output' && item.call_id === 'loop-first',
      ),
    ).toHaveLength(1);
    expect(requests[1]!.previous_response_id).toBe('loop-response-0');
    expect(await readFile(join(lease.root, 'approval-effects.txt'), 'utf8')).toBe('x');
    const secondApprovalMarker = child.getOutput().length;
    complete(1, [call('loop-second')]);
    await child.waitForState((s) => s.output.slice(secondApprovalMarker).includes('Allow this action?'));
    expect(await readFile(join(lease.root, 'approval-effects.txt'), 'utf8')).toBe('x');
    await child.write('y');
    await child.waitForState(() => requests.length === 3);
    complete(2, [message('TWO_APPROVALS_DONE')]);
    await child.waitForVisibleOutput('TWO_APPROVALS_DONE');
    await child.waitForIdleInput({ after: 1 });
    expect(requests).toHaveLength(3);
    expect(
      (requests[2]!.input as Record<string, unknown>[]).filter(
        (item) => item.type === 'function_call_output' && item.call_id === 'loop-second',
      ),
    ).toHaveLength(1);
    expect(requests[2]!.previous_response_id).toBe('loop-response-1');
    expect(await readFile(join(lease.root, 'approval-effects.txt'), 'utf8')).toBe('xx');
    const idle = child.readIdleGeneration();
    await writePtyTextAndSubmit(child, 'FALLBACK_PARENT');
    await child.waitForState(() => requests.length === 4);
    await writePtyTextAndSubmit(child, 'RELEASED_FOLLOWUP');
    await child.waitForComposerValue('');
    complete(3, [message('PARENT_DONE')]);
    await child.waitForState(() => requests.length === 5);
    expect(JSON.stringify(requests[4]!.input).match(/RELEASED_FOLLOWUP/g)).toHaveLength(1);
    complete(4, [message('FOLLOWUP_DONE')]);
    await child.waitForVisibleOutput('FOLLOWUP_DONE');
    await child.waitForIdleInput({ after: idle });
    expect(requests).toHaveLength(5);
    const beforeStop = child.readIdleGeneration();
    await writePtyTextAndSubmit(child, 'STOP_PARENT');
    await child.waitForState(() => requests.length === 6);
    await writePtyTextAndSubmit(child, 'CANCELLED_STEER');
    await child.waitForComposerValue('');
    await child.write('\u0003');
    await child.waitForIdleInput({ after: beforeStop });
    expect(pending[5]!.destroyed).toBe(true);
    await writePtyTextAndSubmit(child, 'AFTER_STOP');
    await child.waitForState(() => requests.length === 7);
    expect(JSON.stringify(requests[6]!.input)).not.toContain('CANCELLED_STEER');
    expect(requests[6]!.previous_response_id).toBeUndefined();
    complete(6, [message('STOP_SUCCESSOR_DONE')]);
    await child.waitForVisibleOutput('STOP_SUCCESSOR_DONE');
    await child.waitForIdleInput({ after: beforeStop + 1 });
    expect(requests).toHaveLength(7);
  } finally {
    await child.cleanup();
    await lease.cleanup();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});
