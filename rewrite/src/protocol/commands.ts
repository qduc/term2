import type { Item, ItemId, ToolCallId } from '../model/index.js';
import type { ClientRequestId, InteractionId, Session } from '../session/index.js';
import type { WireCommand, WireCommandResult } from './index.js';

let nextItem = 0;

/** The inbound half of the protocol: one place turns wire commands into session calls. */
export async function applyCommand(session: Session, command: WireCommand): Promise<WireCommandResult> {
  try {
    switch (command.type) {
      case 'submit': {
        const item: Item = {
          type: 'user_message',
          id: `item_user_${Date.now().toString(36)}_${(nextItem++).toString(36)}` as ItemId,
          content: [{ type: 'text', text: command.text }],
        };
        const admission = await session.submit(command.requestId as ClientRequestId, [item]);
        return admissionResult(admission);
      }
      case 'decide': {
        const pending = session.state().pendingInteraction;
        if (!pending || pending.interaction.interactionId !== command.interactionId)
          throw new Error('stale interaction');
        await session.decide({
          turnId: pending.turnId,
          interactionId: command.interactionId as InteractionId,
          revision: pending.interaction.revision,
          generation: pending.generation,
          decisions: command.decisions.map((decision) => ({
            callId: decision.callId as ToolCallId,
            approve: decision.approve,
            ...(decision.reason ? { reason: decision.reason } : {}),
          })),
        });
        return { ok: true };
      }
      case 'cancel':
        await session.cancel();
        return { ok: true };
      case 'retry':
        return admissionResult(await session.retry());
      case 'compact':
        await session.compact();
        return { ok: true };
      case 'set_model':
        await session.setModel({ provider: command.provider, model: command.model });
        return { ok: true };
    }
  } catch (error) {
    return { ok: false, code: 'command_failed', message: error instanceof Error ? error.message : String(error) };
  }
}

function admissionResult(admission: Awaited<ReturnType<Session['submit']>>): WireCommandResult {
  switch (admission.kind) {
    case 'started':
      return { ok: true, turnId: admission.turnId };
    case 'duplicate':
      return admission.turnId ? { ok: true, turnId: admission.turnId } : { ok: true };
    case 'queued':
      return { ok: true, queuedPosition: admission.position };
    case 'rejected':
      return { ok: false, code: admission.reason, message: `session refused input: ${admission.reason}` };
  }
}
