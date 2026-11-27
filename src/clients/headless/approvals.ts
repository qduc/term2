/** Headless approval policy and once-per-request resolution; no turn advancement. */
import type { DirectConnection } from '../../host/in-process-direct-types.js';
import type { WireDecision, WireInteraction } from '../../protocol/wire.js';
import { interactionLine, rejectionLine } from './format.js';
import type { DirectHeadlessOptions, HeadlessDecision } from './types.js';

const NON_INTERACTIVE_REJECTION_REASON = 'Non-interactive mode: use --auto-approve to allow tool execution';

/**
 * The fallback headless policy, used when the app supplies no decider (the app's
 * own decider settles everything but questions). A headless run never asks
 * (docs/plans/approvals-and-sandbox/headless-approval-redesign.md, decision 1):
 * the mode already approved what it may before a request opened, so an open
 * approval is refused with a reason. Without `--auto-approve` the reason keeps
 * the old wording. A question has no headless answerer. The empty answer plus
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
  if (interaction.toolName === 'sandbox_network_access') {
    return {
      decision: { kind: 'deny', reason: 'Sandbox network access requires an existing project approval.' },
      reportRejection: true,
    };
  }
  if (!autoApprove) {
    return { decision: { kind: 'deny', reason: NON_INTERACTIVE_REJECTION_REASON }, reportRejection: false };
  }
  return {
    decision: { kind: 'deny', reason: 'No person is available to approve this in a non-interactive run.' },
    reportRejection: true,
  };
}

/** Settle snapshot/live interactions through the same policy. False means the
 * answer failed; non-stale failures request best-effort cancellation of the
 * interaction owner. The driver owns its outcome.
 */
export function createHeadlessAnswerer(
  connection: DirectConnection,
  options: DirectHeadlessOptions,
  errorText: (message: string, code?: string) => void,
): (interaction: WireInteraction, fromSnapshot?: boolean) => Promise<boolean> {
  const io = options.io ?? { stdout: process.stdout, stderr: process.stderr };
  const output = options.output ?? 'plain';
  const quiet = options.quiet ?? false;
  const autoApprove = options.autoApprove ?? false;
  const answered = new Set<string>();
  const decide = async (interaction: WireInteraction): Promise<HeadlessDecision> => {
    if (options.decideApproval) return await options.decideApproval(interaction);
    return decideHeadlessApproval(interaction, autoApprove);
  };
  const cancelInteractionOwner = (interaction: WireInteraction): void => {
    void connection
      .send(
        interaction.taskId !== undefined
          ? { type: 'task_control', taskId: interaction.taskId, action: 'cancel' }
          : { type: 'cancel', expectedTurnId: interaction.turnId },
      )
      .catch(() => undefined);
  };

  const answer = async (interaction: WireInteraction, fromSnapshot = false): Promise<boolean> => {
    if (answered.has(interaction.requestId)) return true;
    answered.add(interaction.requestId);
    if (output === 'plain' && !quiet) io.stderr.write(interactionLine(interaction));
    if (options.sessionHandlesHeadlessApprovals === true && !fromSnapshot) {
      return true;
    }
    let decided: HeadlessDecision;
    try {
      decided = await decide(interaction);
    } catch (error) {
      errorText(error instanceof Error ? error.message : String(error));
      cancelInteractionOwner(interaction);
      return false;
    }
    if (decided.reportRejection === true && decided.decision.kind === 'deny') {
      // Legacy: a JSON record on stdout under --json, the plain line on stderr otherwise.
      if (output === 'json')
        io.stdout.write(JSON.stringify({ type: 'approval_rejected', reason: decided.decision.reason }) + '\n');
      else io.stderr.write(rejectionLine(decided.decision.reason));
    }
    const answerFailure = await sendAnswer(interaction.requestId, decided.decision);
    if (answerFailure === null) return true;
    // Cancellation closes pending interactions before the policy answer lands.
    // That stale answer is expected: keep the ordered stream and let the real
    // terminal (cancelled) decide, rather than reporting a failure.
    if (options.signal?.aborted && answerFailure.code === 'stale_interaction') return true;
    // A stale request no longer owns work to cancel; a newer turn may be active.
    if (answerFailure.code !== 'stale_interaction') cancelInteractionOwner(interaction);
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
