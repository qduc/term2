import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordAndSelfValidate } from './fixture-self-validation.js';
import { validateFixtureEnvelope } from './fixture-envelope.js';
import { scanFixtureSecrets } from './fixture-sanitizer.js';

describe('record-from-fake self-validation (plan D4)', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('records from the fake provider, replays to identity, and writes an honestly-labeled envelope', async () => {
    dir = await mkdtemp(join(tmpdir(), 'fixture-self-validation-'));
    const file = await recordAndSelfValidate({
      provider: 'fixture',
      model: 'chat-fixture',
      protocol: 'chat-completions',
      scenario: 'success',
      file: join(dir, 'fixture-chat-completions-success.json'),
    });
    const envelope = validateFixtureEnvelope(JSON.parse(await readFile(file, 'utf8')));
    expect(envelope.capture.sdkPackage).toBe('fixture-fake-provider');
    expect(envelope.capture.apiSdkVersion).toBe('1.0.0');
    expect(envelope.capture.probeScenario).toBe('fake:chat-completions:success');
    const kinds = envelope.turns[0]!.frames.map((frame) => frame.kind);
    expect(kinds).toContain('http-request');
    expect(kinds).toContain('sse-event');
    expect(scanFixtureSecrets(envelope).safe).toBe(true);
  });
});
