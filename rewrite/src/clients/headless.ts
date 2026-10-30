import type { WireInteraction } from '../protocol/index.js';
import type { RunHeadless } from './index.js';

/** Submits one prompt, settles approvals by policy, and returns when the turn ends. */
export const runHeadless: RunHeadless = async (connection, options) => {
  const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const submitted = await connection.send({ type: 'submit', requestId, text: options.prompt });
  if (!submitted.ok) return { exitCode: 2, finalText: submitted.message };

  let finalText = '';
  for await (const event of connection.events) {
    if (event.turnId !== null && event.turnId !== submitted.turnId) continue;
    if (options.output === 'jsonl') process.stdout.write(JSON.stringify(event) + '\n');
    switch (event.type) {
      case 'text_delta':
        if (options.output === 'text') process.stdout.write(String(event.payload.delta));
        break;
      case 'message': {
        const message = event.payload.message as { role: string; text: string };
        if (message.role === 'assistant') finalText = message.text;
        break;
      }
      case 'interaction_opened': {
        const interaction = event.payload.interaction as WireInteraction;
        await connection.send({
          type: 'decide',
          interactionId: interaction.interactionId,
          decisions: interaction.approvals.map((approval) => ({
            callId: approval.callId,
            approve:
              options.onApproval === 'approve_all' ||
              (options.onApproval === 'approve_low_risk' && approval.risk === 'low'),
          })),
        });
        break;
      }
      case 'turn_ended':
        if (options.output === 'text') process.stdout.write('\n');
        return { exitCode: event.payload.outcome === 'completed' ? 0 : 1, finalText };
    }
  }
  return { exitCode: 1, finalText };
};
