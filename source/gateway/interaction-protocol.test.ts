import { describe, expect, it } from 'vitest';
import {
  decideInteraction,
  InteractionProtocolError,
  projectPendingInteraction,
  validatePendingInteractionDto,
} from './interaction-protocol.js';

const base = (overrides: Record<string, unknown> = {}) => ({
  agentName: 'Agent',
  toolName: 'shell',
  argumentsText: 'cat /home/user/private.txt token=secret-value',
  rawInterruption: { credential: 'never-public' },
  ...overrides,
});

const ask = (overrides: Record<string, unknown> = {}) =>
  base({
    toolName: 'ask_user',
    argumentsText: JSON.stringify({
      questions: [
        { question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }], is_multi_select: false },
        { question: 'Pick many', options: [{ label: 'X' }, { label: 'Y' }], is_multi_select: true },
      ],
    }),
    ...overrides,
  });

describe('P105 immutable interaction protocol', () => {
  it('projects ordinary approvals with exact safe fields and redacts path/credential-shaped text', () => {
    const dto = projectPendingInteraction(base(), 'public-a', 1);
    expect(dto).toMatchObject({ kind: 'tool_approval', variant: 'ordinary_tool', revision: 1 });
    expect(dto.choices.map((choice) => choice.id)).toEqual(['approve', 'reject']);
    expect(dto.descriptor.argumentsText).not.toContain('/home/user');
    expect(dto.descriptor.argumentsText).not.toContain('secret-value');
    expect(JSON.stringify(dto)).not.toContain('rawInterruption');
    expect(JSON.stringify(dto)).not.toContain('private.txt');
    expect(validatePendingInteractionDto(dto)).toEqual(dto);
  });

  it.each([
    ['folder_read', { toolName: 'read_file' }, ['allow-once', 'allow-folder-session', 'reject']],
    [
      'outside_workspace_edit',
      { outsideWorkspaceEdit: { path: '/tmp/a', folder: '/tmp' } },
      ['allow-once', 'allow-edit-file-session', 'allow-edit-folder-session', 'reject'],
    ],
    [
      'denied_read',
      { deniedRead: { deniedPath: '/home/u/.ssh/id', suggestedParent: '/home/u/.ssh', sensitive: true } },
      ['allow-once', 'unsandboxed-once', 'deny'],
    ],
    [
      'docker_host_control',
      { dockerHostControl: true },
      ['docker-allow-once', 'docker-allow-session', 'docker-allow-project', 'deny'],
    ],
    [
      'sandbox_network_access',
      { sandboxNetworkAccess: true },
      ['allow-once', 'deny', 'allow-session', 'allow-project'],
    ],
    [
      'post_execute',
      { postExecute: { kind: 'post_execute', sessionId: 's', epoch: 'e', revision: 1, ids: ['c'] } },
      ['approve', 'reject'],
    ],
    ['max_turns', { checkIn: 'max_turns' }, ['continue', 'stop']],
    [
      'run_budget',
      { checkIn: 'run_budget', runBudgetEvent: { evidence: { used: 1, limit: 2, headroom: 1 } } },
      ['continue', 'stop'],
    ],
  ] as const)('constructs the authoritative %s choice set', (_variant, approval, choices) => {
    expect(projectPendingInteraction(base(approval), 'public-a', 1).choices.map((choice) => choice.id)).toEqual(
      choices,
    );
  });

  it('suppresses the denied-read remember choice for sensitive paths', () => {
    const dto = projectPendingInteraction(
      base({ deniedRead: { deniedPath: '/home/u/.ssh/id', suggestedParent: '/home/u/.ssh', sensitive: true } }),
      'public-a',
      1,
    );
    expect(dto.variant).toBe('denied_read');
    expect(dto.choices.map((choice) => choice.id)).not.toContain('allow-remember');
    expect(dto.descriptor.deniedRead).toEqual({
      displayPath: '<outside-workspace>',
      displayParent: '<outside-workspace>',
      sensitive: true,
    });
  });

  it('keeps ask_user identity/revision and accumulated ordered answers', () => {
    const first = projectPendingInteraction(ask(), 'public-ask', 1, [], 0);
    const second = projectPendingInteraction(ask(), 'public-ask', 2, ['A'], 1);
    expect(first.interactionId).toBe(second.interactionId);
    expect(second.revision).toBeGreaterThan(first.revision);
    expect(second.askUser).toMatchObject({ answers: ['A'], currentQuestionIndex: 1 });
    expect(second.choices.map((choice) => choice.id)).toEqual(['option:0', 'option:1', 'custom', 'decline', 'cancel']);
  });

  it('maps only advertised decisions and preserves ask_user terminal semantics', () => {
    const dto = projectPendingInteraction(ask(), 'public-ask', 1, [], 0);
    expect(decideInteraction(dto, { answer: 'option:1' })).toMatchObject({
      answer: 'y',
      approvalAnswer: 'B',
      outcome: 'approved',
    });
    expect(decideInteraction(dto, { answer: 'decline' })).toMatchObject({ answer: 'y', outcome: 'rejected' });
    expect(decideInteraction(dto, { answer: 'cancel' })).toMatchObject({ answer: 'y', outcome: 'cancelled' });
    expect(() => decideInteraction(dto, { answer: 'approve' })).toThrow(InteractionProtocolError);
  });

  it('maps check-in stop and ordinary tool reject to non-continued outcomes', () => {
    const checkIn = projectPendingInteraction(base({ checkIn: 'max_turns' }), 'public-check-in', 1);
    expect(decideInteraction(checkIn, { answer: 'stop' })).toEqual({ answer: 'n', outcome: 'rejected' });
    const ordinary = projectPendingInteraction(base(), 'public-tool', 1);
    expect(decideInteraction(ordinary, { answer: 'reject', rejectionReason: 'not now' })).toEqual({
      answer: 'n',
      rejectionReason: 'not now',
      outcome: 'rejected',
    });
  });

  it('validates multi-select answers against the authoritative displayed options', () => {
    const dto = projectPendingInteraction(ask(), 'public-ask', 1, ['A'], 1);
    expect(decideInteraction(dto, { answer: 'option:0' })).toMatchObject({
      answer: 'y',
      approvalAnswer: '["X"]',
    });
    expect(decideInteraction(dto, { answer: 'custom', approvalAnswer: '["X","Y"]' })).toMatchObject({ answer: 'y' });
    expect(() => decideInteraction(dto, { answer: 'custom', approvalAnswer: '["X","secret"]' })).toThrow(
      InteractionProtocolError,
    );
  });

  it('redacts ask_user question, option, and description text without the literal replacement artifact', () => {
    const dto = projectPendingInteraction(
      ask({
        argumentsText: JSON.stringify({
          questions: [
            {
              question: 'Read /home/user/.ssh/id token=question-secret',
              options: [{ label: 'token=option-secret', description: 'See /tmp/private.txt' }],
              is_multi_select: false,
            },
            { question: 'Next', options: [{ label: 'B' }], is_multi_select: false },
          ],
        }),
      }),
      'public-ask',
      1,
    );
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain('question-secret');
    expect(serialized).not.toContain('option-secret');
    expect(serialized).not.toContain('/tmp/private.txt');
    expect(serialized).not.toContain('$1');
    expect(dto.askUser?.questions[0]).toMatchObject({
      question: 'Read <path> token=<redacted>',
      options: [{ label: 'token=<redacted>', description: 'See <path>' }],
    });
  });

  it('fails closed on malformed ask_user descriptors and private DTO fields', () => {
    expect(() =>
      projectPendingInteraction(base({ toolName: 'ask_user', argumentsText: '{bad' }), 'public-a', 1),
    ).toThrow(InteractionProtocolError);
    const dto = projectPendingInteraction(base(), 'public-a', 1) as Record<string, unknown>;
    dto.privateToken = 'secret';
    expect(() => validatePendingInteractionDto(dto)).toThrow(InteractionProtocolError);
  });
});
