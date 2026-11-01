/** Headless approval policy and once-per-request resolution; no turn advancement. */
import type { DirectConnection } from '../../host/in-process-direct-types.js';
import type { WireDecision, WireInteraction } from '../../protocol/direct-wire.js';
import { interactionLine, rejectionLine } from './format.js';
import type { DirectHeadlessOptions, HeadlessDecision } from './types.js';

const NON_INTERACTIVE_REJECTION_REASON = 'Non-interactive mode: use --auto-approve to allow tool execution';

/**
 * The conservative headless policy. Without `--auto-approve` every tool
 * approval is denied, with the old reason sent to the model. With it, ordinary
 * tools and low/unknown-risk shell commands are allowed; medium/high-risk shell
 * commands are refused because this client cannot reproduce the old evaluator.
 * A question has no headless answerer. The empty answer plus
 * `stopAfterApprovalResolution` is a selected resolution (the source canonical
 * "no answer" result), not a cancellation; it settles that question and
 * suppresses later model work.
 */
export function decideHeadlessApproval(interaction: WireInteraction, autoApprove: boolean): HeadlessDecision {
  if (interaction.kind === 'question') {
    return {
      decision: { kind: 'answer', answer: '', stopAfterApprovalResolution: true },
      reportRejection: false,
    };
  }
  if (!autoApprove) {
    return { decision: { kind: 'deny', reason: NON_INTERACTIVE_REJECTION_REASON }, reportRejection: false };
  }
  if (interaction.toolName !== 'shell' && interaction.toolName !== 'bash') {
    return { decision: { kind: 'allow' } };
  }
  if (interaction.risk === 'medium' || interaction.risk === 'high') {
    const command = commandText(interaction.input);
    const level = interaction.risk === 'high' ? 'RED (dangerous)' : 'YELLOW (suspicious)';
    return {
      decision: {
        kind: 'deny',
        reason: `Heuristic validation failed: command is ${level} and cannot be executed automatically${
          command ? `: ${command}` : ''
        }`,
      },
      reportRejection: true,
    };
  }
  return { decision: { kind: 'allow' } };
}

function commandText(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  const command = (input as Record<string, unknown>)['command'];
  return typeof command === 'string' ? command : '';
}

/** Settle snapshot/live interactions through the same policy. False means the
 * answer failed and a best-effort cancel was sent; the driver owns its outcome.
 */
export function createHeadlessAnswerer(
  connection: DirectConnection,
  options: DirectHeadlessOptions,
  errorText: (message: string, code?: string) => void,
): (interaction: WireInteraction) => Promise<boolean> {
  const io = options.io ?? { stdout: process.stdout, stderr: process.stderr };
  const output = options.output ?? 'plain';
  const quiet = options.quiet ?? false;
  const autoApprove = options.autoApprove ?? false;
  const answered = new Set<string>();
  const decide = async (interaction: WireInteraction): Promise<HeadlessDecision> => {
    if (options.decideApproval) return await options.decideApproval(interaction);
    return decideHeadlessApproval(interaction, autoApprove);
  };

  const answer = async (interaction: WireInteraction): Promise<boolean> => {
    if (answered.has(interaction.requestId)) return true;
    answered.add(interaction.requestId);
    if (output === 'plain' && !quiet) io.stderr.write(interactionLine(interaction));
    let decided: HeadlessDecision;
    try {
      decided = await decide(interaction);
    } catch (error) {
      errorText(error instanceof Error ? error.message : String(error));
      void connection.send({ type: 'cancel' }).catch(() => undefined);
      return false;
    }
    if (decided.reportRejection === true && decided.decision.kind === 'deny') {
      io.stderr.write(rejectionLine(decided.decision.reason));
    }
    const answerFailure = await sendAnswer(interaction.requestId, decided.decision);
    if (answerFailure === null) return true;
    // Cancellation closes pending interactions before the policy answer lands.
    // That stale answer is expected: keep the ordered stream and let the real
    // terminal (cancelled) decide, rather than reporting a failure.
    if (options.signal?.aborted && answerFailure.code === 'stale_interaction') return true;
    void connection.send({ type: 'cancel' }).catch(() => undefined);
    return false;
  };

  /** Null when the answer was accepted; otherwise the protocol failure. */
  const sendAnswer = async (
    requestId: string,
    decision: WireDecision,
  ): Promise<{ readonly code: string; readonly message: string } | null> => {
    try {
      const sent = await connection.send({ type: 'answer', requestId, decision });
      if (sent.ok) return null;
      errorText(sent.message, sent.code);
      return { code: sent.code, message: sent.message };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errorText(message);
      return { code: 'internal_error', message };
    }
  };

  return answer;
}
