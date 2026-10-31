/** HTTP question presentation is client-local. Only the complete typed answer set is resolved
 * through Session; no partial answer, revision, grant or transport credential is a Session fact.
 */
import type {
  WireDecision,
  WireBudgetRequest,
  WireBudgetDecision,
  WireInteraction,
  WireQuestion,
  WireQuestionAnswer,
  WireSnapshot,
} from '../protocol/direct-wire.js';
import type { PendingInteractionDto } from '@qduc/agent-wire';
import type { InteractionResolveBody } from './server-contracts.js';
import { ServerHttpError } from './server-errors.js';

type Choice = { id: string; label: string };
export type ServerInteraction = PendingInteractionDto;
type Progress = { answers: (string | readonly string[])[] };
type Resolution = { kind: 'next'; interaction: ServerInteraction } | { kind: 'decision'; decision: WireDecision };
const DECLINE = 'User declined to answer.';
const CANCEL = 'User did not provide an answer.';

/** Shared only by HTTP attachments to this server, like any client's unfinished form. A process
 * restart resets an unfinished form to question one; Session still owns the unanswered request.
 * Returning accepted:false never claims a durable answer. Final acceptance is Session-owned.
 */
export class ServerInteractions {
  readonly #progress = new Map<string, Map<string, Progress>>();
  observe(snapshot: WireSnapshot): void {
    const requests = this.#progress.get(snapshot.sessionId);
    if (!requests) return;
    const pending = new Set(snapshot.pendingInteractions.map((request) => request.requestId));
    for (const id of requests.keys()) if (!pending.has(id)) requests.delete(id);
    if (!requests.size) this.#progress.delete(snapshot.sessionId);
  }
  forget(sessionId: string, requestId: string): void {
    const requests = this.#progress.get(sessionId);
    requests?.delete(requestId);
    if (!requests?.size) this.#progress.delete(sessionId);
  }
  project(sessionId: string, interaction: WireInteraction): ServerInteraction {
    const answers = this.#progress.get(sessionId)?.get(interaction.requestId)?.answers ?? [];
    const questions = interaction.kind === 'question' ? interaction.questions : undefined;
    // Keep the existing BFF presentation bounds; the direct-wire opt-in retains the full schema.
    if (
      questions &&
      (questions.length === 0 || questions.length > 32 || questions.some((question) => question.options.length > 32))
    )
      throw new ServerHttpError(503, 'gateway_unavailable', 'question schema exceeds the HTTP presentation contract');
    const index = answers.length;
    const question = questions?.[index];
    const questionKind = interaction.kind === 'question';
    const choices: Choice[] = questionKind
      ? [
          ...(question?.options.map((option, optionIndex) => ({
            id: `option:${optionIndex}`,
            label: safeText(option.label, 512),
          })) ?? []),
          ...(!question || question.allowCustom ? [{ id: 'custom', label: 'Custom answer' }] : []),
          { id: 'decline', label: 'Decline' },
          { id: 'cancel', label: 'Cancel' },
        ]
      : [
          { id: 'approve', label: 'Allow' },
          ...interaction.supportedGrants.map((grant) => ({ id: grant, label: grantLabel(grant) })),
          { id: 'reject', label: 'Reject' },
        ];
    const renderedQuestions = questions?.map((value, questionIndex) => ({
      index: questionIndex,
      question: safeText(value.prompt, 4_096),
      options: value.options.map((option) => ({
        label: safeText(option.label, 512),
        ...(option.description ? { description: safeText(option.description, 2_048) } : {}),
      })),
      multiSelect: value.multiple,
    })) ?? [{ index: 0, question: safeText(interaction.summary, 4_096), options: [], multiSelect: false }];
    return {
      version: 1,
      interactionId: interaction.requestId,
      kind: questionKind ? 'ask_user' : 'tool_approval',
      variant: questionKind ? 'ask_user' : 'ordinary_tool',
      revision: index + 1,
      descriptor: {
        agentName: 'assistant',
        toolName: safeText(interaction.toolName, 256),
        argumentsText: safeText(JSON.stringify(interaction.input), 8_192),
      },
      choices,
      ...(questionKind
        ? {
            askUser: {
              questions: renderedQuestions,
              answers: answers.map((answer) =>
                typeof answer === 'string' ? safeText(answer, 16_384) : answer.map((value) => safeText(value, 16_384)),
              ),
              currentQuestionIndex: index,
            },
          }
        : {}),
    };
  }
  /** Run-budget checks are non-tool capabilities. They never become a fake tool approval. */
  projectBudget(request: WireBudgetRequest): ServerInteraction {
    return {
      version: 1,
      interactionId: request.requestId,
      kind: 'check_in',
      variant: 'run_budget',
      revision: 1,
      descriptor: {
        agentName: 'assistant',
        toolName: 'run_budget',
        argumentsText: safeText(JSON.stringify(request.evidence), 8_192),
        checkIn: 'run_budget',
        runBudgetEvidence: {
          pricedUsdMicros: request.snapshot.pricedUsdMicros,
          unpricedTokens: request.snapshot.unpricedTokens,
          activeTimeMs: request.snapshot.activeTimeMs,
          turns: request.snapshot.turns,
          extensionsGranted: request.snapshot.extensionsGranted,
          ...(request.evidence.type === 'budget_stage'
            ? {
                used: request.evidence.evidence.used,
                limit: request.evidence.evidence.limit,
                headroom: request.evidence.evidence.headroom,
              }
            : { count: request.evidence.count, threshold: request.evidence.threshold }),
        },
      },
      choices: [
        { id: 'approve', label: 'Continue' },
        { id: 'reject', label: 'Stop' },
      ],
    };
  }
  resolveBudget(request: WireBudgetRequest, body: InteractionResolveBody): WireBudgetDecision {
    if (body.revision !== 1) throw new ServerHttpError(409, 'stale_interaction', 'interaction revision is stale');
    if (body.approvalAnswer !== undefined || body.rejectionReason !== undefined) return invalid();
    if (!this.projectBudget(request).choices.some((choice) => choice.id === body.answer)) return invalid();
    return body.answer === 'approve' ? { kind: 'extend', grantedBy: 'human' } : { kind: 'stop' };
  }
  resolve(sessionId: string, interaction: WireInteraction, body: InteractionResolveBody): Resolution {
    const dto = this.project(sessionId, interaction);
    if (body.revision !== dto.revision)
      throw new ServerHttpError(409, 'stale_interaction', 'interaction revision is stale');
    if (!dto.choices.some((choice) => choice.id === body.answer)) invalid();
    if (
      body.rejectionReason !== undefined &&
      (dto.kind === 'ask_user' ||
        body.rejectionReason.length > 2_048 ||
        /[\u0000-\u001f\u007f]/.test(body.rejectionReason))
    )
      invalid();
    if (interaction.kind === 'approval') {
      if (body.answer === 'approve') return { kind: 'decision', decision: { kind: 'allow' } };
      const grant = interaction.supportedGrants.find((grant) => grant === body.answer);
      if (grant) return { kind: 'decision', decision: { kind: 'grant', grant } };
      return {
        kind: 'decision',
        decision: { kind: 'deny', ...(body.rejectionReason === undefined ? {} : { reason: body.rejectionReason }) },
      };
    }
    if (body.answer === 'decline') return { kind: 'decision', decision: { kind: 'decline' } };
    if (body.answer === 'cancel')
      return { kind: 'decision', decision: { kind: 'answer', answer: CANCEL, stopAfterApprovalResolution: true } };
    const previous = this.#progress.get(sessionId)?.get(interaction.requestId)?.answers ?? [];
    const question = interaction.questions?.[previous.length];
    const value = questionAnswer(question, body);
    if (!question) return { kind: 'decision', decision: { kind: 'answer', answer: String(value) } };
    const values = [...previous, value];
    if (values.length < interaction.questions!.length) {
      let requests = this.#progress.get(sessionId);
      if (!requests) {
        requests = new Map();
        this.#progress.set(sessionId, requests);
      }
      requests.set(interaction.requestId, { answers: values });
      return { kind: 'next', interaction: this.project(sessionId, interaction) };
    }
    const answers: WireQuestionAnswer[] = interaction.questions!.map((question, index) => ({
      questionId: question.id,
      value: values[index],
    }));
    return { kind: 'decision', decision: { kind: 'answers', answers } };
  }
}
function questionAnswer(question: WireQuestion | undefined, body: InteractionResolveBody): string | readonly string[] {
  if (body.answer.startsWith('option:')) {
    const option = question?.options[Number(body.answer.slice(7))];
    if (!option) return invalid();
    return question!.multiple ? [option.label] : option.label;
  }
  const answer = body.approvalAnswer;
  if (!answer || answer.length > 16_384 || [DECLINE, CANCEL].includes(answer)) return invalid();
  if (!question?.multiple) return answer;
  let values: unknown;
  try {
    values = JSON.parse(answer);
  } catch {
    return invalid();
  }
  if (
    !Array.isArray(values) ||
    values.length > 32 ||
    !values.length ||
    values.some((entry) => !question.options.some((option) => option.label === entry))
  )
    return invalid();
  return values as string[];
}
function invalid(): never {
  throw new ServerHttpError(400, 'validation_error', 'interaction decision is invalid');
}
function grantLabel(grant: string): string {
  const labels: Record<string, string> = {
    'allow-remember': 'Allow and remember',
    'unsandboxed-once': 'Run unsandboxed once',
    'allow-folder-session': 'Allow folder for session',
    'allow-edit-file-session': 'Allow file for session',
    'allow-edit-folder-session': 'Allow folder for session',
    'docker-allow-once': 'Allow once',
    'docker-allow-session': 'Allow for session',
    'docker-allow-project': 'Allow for project',
  };
  return labels[grant] ?? grant;
}
function safeText(value: string, max: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=<redacted>')
    .replace(/(?:[A-Za-z]:[\\/]|\/)(?:[A-Za-z0-9._~@-]+[\\/])+[A-Za-z0-9._~@-]+/g, '<path>')
    .slice(0, max);
}
