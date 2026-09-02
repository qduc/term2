import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGatewayEventJournal } from './persistence/event-journal.js';
import { InteractionCheckpointStore } from './persistence/interaction-checkpoint.js';
import type { PendingInteractionDto } from './interaction-protocol.js';

const roots: string[] = [];
const root = () => {
  const value = mkdtempSync(path.join('/tmp', 'term2-persistence-matrix-'));
  roots.push(value);
  return value;
};
afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

type Boundary =
  | 'before_user_message_fsync'
  | 'after_user_message_fsync'
  | 'during_text_delta'
  | 'after_tool_started'
  | 'after_tool_result'
  | 'during_approval'
  | 'after_final_canonical_append'
  | 'during_journal_compaction';

async function appendTurnFact(
  journal: ReturnType<typeof createGatewayEventJournal>,
  type: Parameters<typeof journal.append>[0]['type'],
  turnId: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await journal.append(
    { sessionId: journal.sessionId, type, payload: { turnId, ...payload } },
    { durability: type === 'text_delta' || type === 'reasoning_delta' ? 'stream' : 'critical' },
  );
}

describe('persistence restart boundary matrix', () => {
  it('recovers one pending interaction exactly once and never leaves it actionable', async () => {
    const directory = path.join(root(), 'interaction-recovery');
    const sessionId = 'session-interaction';
    const turnId = 'turn-interaction';
    const interaction = {
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
    };
    const first = createGatewayEventJournal({ sessionId, directory });
    await first.append({ sessionId, type: 'session_created', payload: {} }, { durability: 'critical' });
    await first.append(
      { sessionId, type: 'approval_required', payload: { turnId, interaction } },
      { durability: 'critical' },
    );
    const checkpoint = new InteractionCheckpointStore(directory);
    checkpoint.save({
      turnId,
      interaction: interaction as PendingInteractionDto,
      revision: 1,
      generation: 'generation-a',
    });
    first.close();

    const restarted = createGatewayEventJournal({ sessionId, directory });
    const recovered = new InteractionCheckpointStore(directory);
    await recovered.recover(restarted);
    expect(restarted.events().map((event) => event.type)).toEqual([
      'session_created',
      'approval_required',
      'interaction_recovered',
    ]);
    expect(restarted.events().at(-1)?.payload).toMatchObject({
      turnId,
      interaction,
      reason: 'daemon_restart',
    });
    expect(recovered.current).toBeNull();
    await recovered.recover(restarted);
    expect(restarted.events().filter((event) => event.type === 'interaction_recovered')).toHaveLength(1);
    restarted.close();
  });

  it('re-sanitizes checkpoint DTO text before recovery publication', async () => {
    const directory = path.join(root(), 'interaction-recovery-sanitization');
    const journal = createGatewayEventJournal({ sessionId: 'session-sanitize', directory });
    const checkpoint = new InteractionCheckpointStore(directory);
    checkpoint.save({
      turnId: 'turn-sanitize',
      interaction: {
        version: 1,
        interactionId: 'public-sanitize',
        kind: 'ask_user',
        variant: 'ask_user',
        descriptor: { agentName: 'Agent', toolName: 'ask_user', argumentsText: 'token=hidden' },
        choices: [{ id: 'option:0', label: 'token=hidden' }],
        askUser: {
          questions: [
            {
              index: 0,
              question: 'Read /home/user/.ssh/id',
              options: [{ label: 'token=hidden', description: 'See /tmp/private.txt' }],
              multiSelect: false,
            },
          ],
          answers: [],
          currentQuestionIndex: 0,
        },
        revision: 1,
      },
      revision: 1,
      generation: 'generation-sanitize',
    });
    await checkpoint.recover(journal);
    const recovered = journal.events().at(-1)?.payload.interaction as Record<string, any>;
    expect(JSON.stringify(recovered)).not.toContain('hidden');
    expect(JSON.stringify(recovered)).not.toContain('/tmp/private.txt');
    expect(JSON.stringify(recovered)).not.toContain('$1');
    journal.close();
  });

  it('restarts through each named durable boundary without sequence reuse or duplicated facts', async () => {
    const boundaries: Boundary[] = [
      'before_user_message_fsync',
      'after_user_message_fsync',
      'during_text_delta',
      'after_tool_started',
      'after_tool_result',
      'during_approval',
      'after_final_canonical_append',
      'during_journal_compaction',
    ];
    for (const boundary of boundaries) {
      const sessionId = `session-${boundary}`;
      const directory = path.join(root(), boundary);
      const first = createGatewayEventJournal({ sessionId, directory });
      const turnId = `turn-${boundary}`;
      await first.append({ sessionId, type: 'session_created', payload: {} }, { durability: 'critical' });
      switch (boundary) {
        case 'before_user_message_fsync':
          break;
        case 'after_user_message_fsync':
          await appendTurnFact(first, 'user_message_accepted', turnId);
          break;
        case 'during_text_delta':
          await appendTurnFact(first, 'user_message_accepted', turnId);
          await appendTurnFact(first, 'text_delta', turnId, { delta: 'partial' });
          await appendTurnFact(first, 'reasoning_delta', turnId, { delta: 'thinking' });
          break;
        case 'after_tool_started':
          await appendTurnFact(first, 'user_message_accepted', turnId);
          await appendTurnFact(first, 'tool_started', turnId, { callId: 'call-a', toolName: 'shell' });
          await appendTurnFact(first, 'command_message', turnId, { message: { id: 'command-a', sender: 'agent' } });
          break;
        case 'after_tool_result':
          await appendTurnFact(first, 'user_message_accepted', turnId);
          await appendTurnFact(first, 'tool_started', turnId, { callId: 'call-a', toolName: 'shell' });
          await appendTurnFact(first, 'command_message', turnId, { message: { id: 'command-a', sender: 'agent' } });
          await appendTurnFact(first, 'tool_started', turnId, { callId: 'call-b', toolName: 'shell' });
          break;
        case 'during_approval': {
          await appendTurnFact(first, 'approval_required', turnId, { interaction: { kind: 'approval' } });
          const checkpoint = new InteractionCheckpointStore(directory);
          checkpoint.save({
            turnId,
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
            } as const,
            revision: 1,
            generation: 'generation-a',
          });
          break;
        }
        case 'after_final_canonical_append':
          await appendTurnFact(first, 'turn_completed', turnId);
          break;
        case 'during_journal_compaction':
          await appendTurnFact(first, 'user_message_accepted', turnId);
          await appendTurnFact(first, 'text_delta', turnId, { delta: 'complete' });
          await appendTurnFact(first, 'turn_completed', turnId);
          first.compactThrough(first.highWater().lastPublishedSequence);
          break;
      }
      const observed = first.events().map((event) => event.id);
      const lastBeforeRestart = first.highWater().lastAppendedSequence;
      first.close();

      const restarted = createGatewayEventJournal({ sessionId, directory });
      expect(restarted.highWater().lastAppendedSequence).toBe(lastBeforeRestart);
      await restarted.append(
        { sessionId, type: 'turn_failed', payload: { turnId, reason: 'recovered' } },
        { durability: 'critical' },
      );
      const next = restarted.events().at(-1)!.id;
      expect(next).toBe(lastBeforeRestart + 1);
      expect(new Set([...observed, next]).size).toBe(observed.length + 1);
      restarted.close();
    }
  });
});
