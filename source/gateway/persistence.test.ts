import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGatewayStorageLayout } from './persistence/storage.js';
import { GatewaySessionIndex } from './persistence/session-index.js';
import { createGatewayEventJournal } from './persistence/event-journal.js';
import { createSessionPersistence } from './persistence/session-persistence.js';
import { GatewayAdmissionPersistence, normalizedBodyHash } from './persistence/admission-persistence.js';
import { InteractionCheckpointStore } from './persistence/interaction-checkpoint.js';
import { GatewayPersistenceError } from './persistence/contracts.js';
import { hydrateTranscript, createSessionProjectionSource } from './persistence/projection.js';
import { GatewayRetentionManager } from './persistence/retention.js';
import { GatewayPersistenceCoordinator, computeBindingFingerprint } from './persistence/coordinator.js';

const roots: string[] = [];
const root = () => {
  const value = mkdtempSync(path.join('/tmp', 'term2-persistence-'));
  roots.push(value);
  return value;
};

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('gateway persistence storage and index', () => {
  it('does not persist an accepted record when the runtime rejects queue admission', async () => {
    const layout = createGatewayStorageLayout(root());
    const index = new GatewaySessionIndex(layout);
    const now = new Date().toISOString();
    index.create({
      id: 'session-a',
      ownerUserId: 'owner-a',
      workspaceId: 'workspace-a',
      grantVersion: '1',
      bindingFingerprint: 'fingerprint-a',
      status: 'idle',
      createdAt: now,
      updatedAt: now,
    });
    const admissions = new GatewayAdmissionPersistence(index);
    const result = await admissions.admit({
      ownerUserId: 'owner-a',
      sessionId: 'session-a',
      clientRequestId: 'request-a',
      body: { text: 'hello' },
      turnId: 'turn-a',
      runtime: {
        prepareMessage: async () => ({ kind: 'rejected' as const, reason: 'queue_full' as const }),
        commitMessage: async () => undefined,
        cancelPreparedMessage: async () => undefined,
      },
      persistence: {} as never,
      term2Fact: { type: 'session_init', id: 'session-a', createdAt: now },
      acceptedEvent: { sessionId: 'session-a', type: 'user_message_accepted', payload: { turnId: 'turn-a' } },
    });
    expect(result).toEqual({ kind: 'rejected', reason: 'queue_full' });
    expect(index.admission('owner-a', 'session-a', 'request-a')).toBeNull();
    index.close();
  });

  it('persists idempotency records and distinguishes replay from body conflict', () => {
    const layout = createGatewayStorageLayout(root());
    const index = new GatewaySessionIndex(layout);
    const now = new Date().toISOString();
    index.create({
      id: 'session-a',
      ownerUserId: 'owner-a',
      workspaceId: 'workspace-a',
      grantVersion: '1',
      bindingFingerprint: 'fingerprint-a',
      status: 'idle',
      createdAt: now,
      updatedAt: now,
    });
    const admissions = new GatewayAdmissionPersistence(index);
    const first = admissions.prepare({
      ownerUserId: 'owner-a',
      sessionId: 'session-a',
      clientRequestId: 'request-a',
      body: { text: 'hello' },
      turnId: 'turn-a',
    });
    index.updateAdmission('owner-a', 'session-a', 'request-a', {
      state: 'accepted',
      result: 'accepted',
      phase: 'committed',
    });
    expect(first.normalizedBodyHash).toBe(normalizedBodyHash({ text: 'hello' }));
    expect(admissions.lookup('owner-a', 'session-a', 'request-a', { text: 'hello' })).toMatchObject({
      kind: 'replayed',
    });
    expect(admissions.lookup('owner-a', 'session-a', 'request-a', { text: 'changed' })).toMatchObject({
      kind: 'conflict',
    });
    index.close();
  });

  it('uses restrictive hashed paths and owner-scoped bounded index pages', () => {
    const layout = createGatewayStorageLayout(root());
    const index = new GatewaySessionIndex(layout);
    const now = new Date().toISOString();
    index.create({
      id: 'session-a',
      ownerUserId: 'owner-a',
      workspaceId: 'workspace-a',
      grantVersion: '1',
      bindingFingerprint: 'fingerprint-a',
      status: 'idle',
      createdAt: now,
      updatedAt: now,
    });
    index.create({
      id: 'session-b',
      ownerUserId: 'owner-b',
      workspaceId: 'workspace-b',
      grantVersion: '1',
      bindingFingerprint: 'fingerprint-b',
      status: 'idle',
      createdAt: now,
      updatedAt: now,
    });
    const page = index.list('owner-a', { limit: 50 });
    expect(page.sessions).toEqual([
      expect.objectContaining({ id: 'session-a', workspaceId: 'workspace-a', latestSequence: 0 }),
    ]);
    expect(JSON.stringify(page)).not.toContain('owner-a');
    expect(layout.sessionPath('owner-a', 'workspace-a', 'session-a')).not.toContain('owner-a');
    expect(() => index.getForOwner('owner-a', 'session-b')).toThrowError(
      expect.objectContaining({ code: 'owner_mismatch' }),
    );
    index.close();
  });
});

describe('GatewayEventJournal', () => {
  it('appends before publishing, preserves high-water across reopen, and requires reload after compaction', async () => {
    const directory = path.join(createGatewayStorageLayout(root()).sessionsPath, 'journal');
    const journal = createGatewayEventJournal({ sessionId: 'session-a', directory });
    const published: number[] = [];
    const publishedAfterDiskWrite: boolean[] = [];
    const first = journal.subscribeFrom(0, (event) => {
      published.push(event.id);
      publishedAfterDiskWrite.push(
        readFileSync(path.join(directory, 'events.jsonl'), 'utf8').includes(`"id":${event.id}`),
      );
    });
    expect(first.kind).toBe('subscribed');
    await journal.append({ sessionId: 'session-a', type: 'session_created', payload: {} }, { durability: 'critical' });
    await journal.append(
      { sessionId: 'session-a', type: 'assistant_started', payload: { turnId: 'turn-a' } },
      { durability: 'stream' },
    );
    expect(published).toEqual([1, 2]);
    expect(publishedAfterDiskWrite).toEqual([true, true]);
    expect(journal.highWater()).toMatchObject({ lastAppendedSequence: 2, lastPublishedSequence: 2 });
    journal.close();

    const reopened = createGatewayEventJournal({ sessionId: 'session-a', directory });
    expect(reopened.highWater().lastAppendedSequence).toBe(2);
    reopened.compactThrough(1);
    expect(reopened.subscribeFrom(0, () => undefined)).toMatchObject({
      kind: 'reload_required',
      reason: 'cursor_compacted',
    });
    const replay = reopened.subscribeFrom(1, () => undefined);
    expect(replay).toMatchObject({ kind: 'subscribed', replay: [{ id: 2 }] });
    await reopened.append(
      { sessionId: 'session-a', type: 'turn_completed', payload: { turnId: 'turn-a' } },
      { durability: 'critical' },
    );
    expect(reopened.highWater().lastAppendedSequence).toBe(3);
    reopened.close();
  });

  it('rejects foreign and unsanitized events without publication', async () => {
    const directory = path.join(createGatewayStorageLayout(root()).sessionsPath, 'journal');
    const journal = createGatewayEventJournal({ sessionId: 'session-a', directory });
    const listener = vi.fn();
    journal.subscribeFrom(null, listener);
    await expect(
      journal.append({ sessionId: 'session-b', type: 'session_created', payload: {} }, { durability: 'critical' }),
    ).rejects.toMatchObject({ code: 'corrupt' });
    expect(listener).not.toHaveBeenCalled();
    await expect(
      journal.append(
        { sessionId: 'session-a', type: 'turn_failed', payload: { turnId: 'turn-a', projectPath: '/secret' } },
        { durability: 'critical' },
      ),
    ).rejects.toMatchObject({ code: 'corrupt' });
    expect(listener).not.toHaveBeenCalled();
    journal.close();
  });
});

describe('SessionPersistenceHandle and critical persistence', () => {
  it('writes safe init metadata and no CLI last.json, then releases its lock', async () => {
    const layout = createGatewayStorageLayout(root());
    const handle = createSessionPersistence({
      layout,
      ownerUserId: 'owner-a',
      workspaceId: 'workspace-a',
      sessionId: 'session-a',
    });
    await handle.critical.appendCritical(
      { type: 'session_init', id: 'session-a', createdAt: new Date().toISOString() },
      { sessionId: 'session-a', type: 'session_created', payload: {} },
    );
    handle.critical.assertHealthy();
    const log = readFileSync(path.join(handle.directory, 'term2.jsonl'), 'utf8');
    expect(log).not.toContain('projectPath');
    expect(log).not.toContain('owner-a');
    expect(existsSync(path.join(layout.root, 'last.json'))).toBe(false);
    await handle.close();
    expect(existsSync(path.join(handle.directory, 'term2.lock'))).toBe(false);
  });

  it('recovers a pending interaction as non-resolvable exactly once', async () => {
    const layout = createGatewayStorageLayout(root());
    const directory = path.join(layout.sessionsPath, 'journal');
    const journal = createGatewayEventJournal({ sessionId: 'session-a', directory });
    const checkpoint = new InteractionCheckpointStore(directory);
    checkpoint.save({
      turnId: 'turn-a',
      interaction: {
        version: 1,
        interactionId: 'public-interaction',
        kind: 'tool_approval',
        variant: 'ordinary_tool',
        descriptor: { agentName: 'Agent', toolName: 'shell', argumentsText: 'echo safe' },
        choices: [
          { id: 'approve', label: 'Allow' },
          { id: 'reject', label: 'Reject' },
        ],
        revision: 1,
      },
      revision: 1,
      generation: 'generation-a',
    });
    await checkpoint.recover(journal);
    expect(journal.events()).toEqual([expect.objectContaining({ type: 'interaction_recovered' })]);
    expect(checkpoint.current).toBeNull();
    journal.close();
  });

  it('does not overlay recovery after a resolved interaction when turn_failed was not appended', async () => {
    const layout = createGatewayStorageLayout(root());
    const index = new GatewaySessionIndex(layout);
    const now = new Date().toISOString();
    index.create({
      id: 'session-resolved-recovery',
      ownerUserId: 'owner-a',
      workspaceId: 'workspace-a',
      grantVersion: '1',
      bindingFingerprint: 'fingerprint-a',
      status: 'interrupted',
      createdAt: now,
      updatedAt: now,
    });
    const directory = layout.sessionPath('owner-a', 'workspace-a', 'session-resolved-recovery');
    const journal = createGatewayEventJournal({ sessionId: 'session-resolved-recovery', directory });
    const interaction = {
      version: 1 as const,
      interactionId: 'resolved-recovery-interaction',
      kind: 'tool_approval' as const,
      variant: 'ordinary_tool' as const,
      descriptor: { agentName: 'Agent', toolName: 'shell', argumentsText: 'echo safe' },
      choices: [
        { id: 'approve', label: 'Allow' },
        { id: 'reject', label: 'Reject' },
      ],
      revision: 1,
    };
    await journal.append(
      { sessionId: journal.sessionId, type: 'session_created', payload: {} },
      { durability: 'critical' },
    );
    await journal.append(
      { sessionId: journal.sessionId, type: 'approval_required', payload: { turnId: 'turn-resolved', interaction } },
      { durability: 'critical' },
    );
    await journal.append(
      {
        sessionId: journal.sessionId,
        type: 'interaction_resolved',
        payload: {
          turnId: 'turn-resolved',
          interactionId: interaction.interactionId,
          outcome: 'approved',
          variant: interaction.variant,
        },
      },
      { durability: 'critical' },
    );
    const checkpoint = new InteractionCheckpointStore(directory);
    checkpoint.save({
      turnId: 'turn-resolved',
      interaction,
      revision: 1,
      generation: 'generation-failed-continuation',
    });
    await checkpoint.recover(journal);
    const source = await createSessionProjectionSource({
      index,
      layout,
      ownerUserId: 'owner-a',
      sessionId: 'session-resolved-recovery',
      journal,
    });
    expect(journal.events().map((event) => event.type)).toEqual([
      'session_created',
      'approval_required',
      'interaction_resolved',
      'interaction_recovered',
    ]);
    expect(source.interaction).toBeNull();
    expect(source.resolvedInteractionIds.has(interaction.interactionId)).toBe(true);
    journal.close();
    index.close();
  });

  it('treats a malformed committed middle journal record as corruption', async () => {
    const layout = createGatewayStorageLayout(root());
    const directory = path.join(layout.sessionsPath, 'journal');
    const eventPath = path.join(directory, 'events.jsonl');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      eventPath,
      `${JSON.stringify({
        schemaVersion: 1,
        id: 1,
        sessionId: 'session-a',
        type: 'session_created',
        occurredAt: new Date().toISOString(),
        payload: {},
      })}\nnot-json\n`,
    );
    expect(() => createGatewayEventJournal({ sessionId: 'session-a', directory })).toThrowError(
      expect.objectContaining({ code: 'corrupt' }),
    );
  });
});

describe('P103C1 persistence corrections', () => {
  it('never reuses a sequence after compact-to-empty or partial compaction restart', async () => {
    const directory = path.join(createGatewayStorageLayout(root()).sessionsPath, 'journal');
    const journal = createGatewayEventJournal({ sessionId: 'session-a', directory });
    await journal.append({ sessionId: 'session-a', type: 'session_created', payload: {} }, { durability: 'critical' });
    await journal.append(
      { sessionId: 'session-a', type: 'assistant_started', payload: { turnId: 'turn-a' } },
      { durability: 'critical' },
    );
    await journal.append(
      { sessionId: 'session-a', type: 'turn_completed', payload: { turnId: 'turn-a' } },
      { durability: 'critical' },
    );
    journal.compactThrough(3);
    journal.close();
    const empty = createGatewayEventJournal({ sessionId: 'session-a', directory });
    await empty.append(
      { sessionId: 'session-a', type: 'turn_failed', payload: { turnId: 'turn-b' } },
      { durability: 'critical' },
    );
    expect(empty.events().at(-1)?.id).toBe(4);
    empty.close();

    const partialDirectory = path.join(createGatewayStorageLayout(root()).sessionsPath, 'journal');
    const partial = createGatewayEventJournal({ sessionId: 'session-b', directory: partialDirectory });
    await partial.append({ sessionId: 'session-b', type: 'session_created', payload: {} }, { durability: 'critical' });
    await partial.append(
      { sessionId: 'session-b', type: 'assistant_started', payload: { turnId: 'turn-a' } },
      { durability: 'critical' },
    );
    await partial.append(
      { sessionId: 'session-b', type: 'turn_completed', payload: { turnId: 'turn-a' } },
      { durability: 'critical' },
    );
    partial.compactThrough(1);
    partial.close();
    const partialRestart = createGatewayEventJournal({ sessionId: 'session-b', directory: partialDirectory });
    await partialRestart.append(
      { sessionId: 'session-b', type: 'turn_failed', payload: { turnId: 'turn-b' } },
      { durability: 'critical' },
    );
    expect(partialRestart.events().map((event) => event.id)).toEqual([2, 3, 4]);
    partialRestart.close();
  });

  it('rejects deferred event families before sequencing or publication', async () => {
    const directory = path.join(createGatewayStorageLayout(root()).sessionsPath, 'journal');
    const journal = createGatewayEventJournal({ sessionId: 'session-a', directory });
    await expect(
      journal.append(
        { sessionId: 'session-a', type: 'subagent_started' as never, payload: { turnId: 'turn-a' } },
        { durability: 'critical' },
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(journal.highWater().lastAppendedSequence).toBe(0);
    journal.close();
  });

  it('uses locale-independent idempotency canonicalization', () => {
    expect(normalizedBodyHash({ Z: 1, a: 2 })).toBe(normalizedBodyHash({ a: 2, Z: 1 }));
  });

  it('rejects a non-fsync term2 fact at the critical persistence boundary', async () => {
    const layout = createGatewayStorageLayout(root());
    const handle = createSessionPersistence({
      layout,
      ownerUserId: 'owner-a',
      workspaceId: 'workspace-a',
      sessionId: 'session-a',
    });
    await expect(
      handle.critical.appendCritical(
        { type: 'settings_changed', key: 'agent.model', value: 'x' },
        { sessionId: 'session-a', type: 'session_created', payload: {} },
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    await handle.close();
  });

  it('repairs a torn canonical tail and quarantines a corrupt sidecar', () => {
    const layout = createGatewayStorageLayout(root());
    const directory = layout.sessionPath('owner-a', 'workspace-a', 'session-a');
    const init = {
      v: 3,
      seq: 1,
      ts: new Date().toISOString(),
      event: { type: 'session_init', id: 'session-a', createdAt: new Date().toISOString() },
    };
    writeFileSync(path.join(directory, 'term2.jsonl'), JSON.stringify(init) + '\n{"v":3,"seq":2');
    writeFileSync(path.join(directory, 'term2.deltas'), '{not-json');
    expect(hydrateTranscript(directory, 'session-a')).not.toBeNull();
    expect(existsSync(path.join(directory, 'corruption'))).toBe(true);
  });

  it('rejects malformed canonical middle lines and duplicate merged sequences', () => {
    const layout = createGatewayStorageLayout(root());
    const directory = layout.sessionPath('owner-a', 'workspace-a', 'session-a');
    const init = {
      v: 3,
      seq: 1,
      ts: new Date().toISOString(),
      event: { type: 'session_init', id: 'session-a', createdAt: new Date().toISOString() },
    };
    writeFileSync(
      path.join(directory, 'term2.jsonl'),
      JSON.stringify(init) + '\nnot-json\n' + JSON.stringify({ ...init, seq: 3 }),
    );
    expect(() => hydrateTranscript(directory, 'session-a')).toThrowError(expect.objectContaining({ code: 'corrupt' }));
    writeFileSync(path.join(directory, 'term2.jsonl'), JSON.stringify(init) + '\n');
    writeFileSync(path.join(directory, 'term2.deltas'), JSON.stringify({ ...init, seq: 1 }) + '\n');
    expect(() => hydrateTranscript(directory, 'session-a')).toThrowError(expect.objectContaining({ code: 'corrupt' }));
  });

  it('projects a live pending interaction and uses the generation reload result', async () => {
    const layout = createGatewayStorageLayout(root());
    const index = new GatewaySessionIndex(layout);
    const now = new Date().toISOString();
    index.create({
      id: 'session-a',
      ownerUserId: 'owner-a',
      workspaceId: 'workspace-a',
      grantVersion: '1',
      bindingFingerprint: 'fingerprint-a',
      status: 'idle',
      createdAt: now,
      updatedAt: now,
    });
    const directory = layout.sessionPath('owner-a', 'workspace-a', 'session-a');
    const journal = createGatewayEventJournal({ sessionId: 'session-a', directory, transcriptGeneration: 2 });
    const source = await createSessionProjectionSource({
      index,
      layout,
      ownerUserId: 'owner-a',
      sessionId: 'session-a',
      journal,
      liveInteraction: async () => ({
        state: 'pending' as const,
        interaction: { kind: 'approval' } as any,
        turnId: 'turn-a',
      }),
    });
    expect(source.interaction).toEqual({ state: 'pending', interaction: { kind: 'approval' }, turnId: 'turn-a' });
    expect(journal.subscribeFrom(0, () => undefined, 1)).toMatchObject({
      kind: 'reload_required',
      reason: 'generation_mismatch',
    });
    journal.close();
    index.close();
  });

  it('sets retention eligibility on close and evicts only closed sessions under a lock', () => {
    const layout = createGatewayStorageLayout(root());
    const index = new GatewaySessionIndex(layout, { closedRetentionMs: 1 });
    const now = new Date().toISOString();
    index.create({
      id: 'session-a',
      ownerUserId: 'owner-a',
      workspaceId: 'workspace-a',
      grantVersion: '1',
      bindingFingerprint: 'fingerprint-a',
      status: 'idle',
      createdAt: now,
      updatedAt: now,
    });
    layout.sessionPath('owner-a', 'workspace-a', 'session-a');
    index.update('session-a', { status: 'closed' });
    const manager = new GatewayRetentionManager(index, layout, { closedRetentionMs: 1 });
    expect(manager.evictEligible(Date.now() + 10)).toEqual(['session-a']);
    expect(index.get('session-a')).toBeNull();
    index.close();
  });

  it('fingerprints canonical binding inputs without disclosing them', () => {
    const base = {
      sessionId: 'session-a',
      ownerUserId: 'owner-a',
      workspaceId: 'workspace-a',
      grantVersion: 1,
      canonicalRoot: '/one',
      access: 'read' as const,
    };
    expect(computeBindingFingerprint(base)).not.toBe(computeBindingFingerprint({ ...base, canonicalRoot: '/two' }));
  });

  it('rejects foreign-key admission inserts with a typed conflict', () => {
    const index = new GatewaySessionIndex(createGatewayStorageLayout(root()));
    expect(() =>
      index.insertAdmission({
        ownerUserId: 'owner-a',
        sessionId: 'missing',
        clientRequestId: 'request-a',
        normalizedBodyHash: 'hash',
        turnId: 'turn-a',
        state: 'prepared',
        phase: 'prepared',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 1000).toISOString(),
      }),
    ).toThrowError(expect.objectContaining({ code: 'conflict' }));
    index.close();
  });

  it('reconciles a durable transcript phase instead of cancelling it', async () => {
    const layout = createGatewayStorageLayout(root());
    const index = new GatewaySessionIndex(layout);
    const now = new Date().toISOString();
    index.create({
      id: 'session-a',
      ownerUserId: 'owner-a',
      workspaceId: 'workspace-a',
      grantVersion: '1',
      bindingFingerprint: 'fingerprint-a',
      status: 'idle',
      createdAt: now,
      updatedAt: now,
    });
    const admissions = new GatewayAdmissionPersistence(index);
    const record = admissions.prepare({
      ownerUserId: 'owner-a',
      sessionId: 'session-a',
      clientRequestId: 'request-a',
      body: { text: 'hello' },
      turnId: 'turn-a',
    });
    index.updateAdmission('owner-a', 'session-a', 'request-a', {
      phase: 'transcript_written',
      transcriptChecksum: record.transcriptChecksum ?? 'checksum',
    });
    const repaired = await admissions.reconcile('owner-a', 'session-a', 'request-a', {
      cancelPrepared: async () => {
        throw new Error('must not cancel');
      },
      verifyTranscript: async (candidate) => candidate.transcriptChecksum === 'checksum',
      repairAcceptedEvent: async () => undefined,
    });
    expect(repaired).toMatchObject({ state: 'accepted', phase: 'committed' });
    index.close();
  });

  it('startup reconciliation rejects accepted-unstarted work exactly once', async () => {
    const layout = createGatewayStorageLayout(root());
    const index = new GatewaySessionIndex(layout);
    const binding = {
      sessionId: 'session-a',
      ownerUserId: 'owner-a',
      workspaceId: 'workspace-a',
      grantVersion: 1,
      canonicalRoot: '/workspace',
      access: 'read' as const,
    };
    const now = new Date().toISOString();
    index.create({
      id: binding.sessionId,
      ownerUserId: binding.ownerUserId,
      workspaceId: binding.workspaceId,
      grantVersion: '1',
      bindingFingerprint: computeBindingFingerprint(binding),
      status: 'running',
      activeTurnId: 'turn-a',
      createdAt: now,
      updatedAt: now,
    });
    const admissions = new GatewayAdmissionPersistence(index);
    admissions.prepare({
      ownerUserId: 'owner-a',
      sessionId: 'session-a',
      clientRequestId: 'request-a',
      body: { text: 'hello' },
      turnId: 'turn-a',
    });
    index.updateAdmission('owner-a', 'session-a', 'request-a', {
      state: 'accepted',
      result: 'accepted',
      phase: 'committed',
    });
    const persistence = createSessionPersistence({
      layout,
      ownerUserId: 'owner-a',
      workspaceId: 'workspace-a',
      sessionId: 'session-a',
    });
    const coordinator = new GatewayPersistenceCoordinator(layout, index);
    await coordinator.reconcileStartup(binding, persistence);
    expect(index.get('session-a')).toMatchObject({ status: 'interrupted', activeTurnId: undefined });
    expect(persistence.journal.events()).toEqual([
      expect.objectContaining({
        type: 'user_message_rejected',
        payload: expect.objectContaining({ turnId: 'turn-a', reason: 'queue_discarded' }),
      }),
    ]);
    await coordinator.reconcileStartup(binding, persistence);
    expect(persistence.journal.events()).toHaveLength(1);
    await persistence.close();
    index.close();
  });
});
