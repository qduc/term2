/** Numbered /answer selection against the interaction IDs captured when typing began. */
import type { WireDecision } from '../../protocol/direct-wire.js';
import type { InteractionView } from './state.js';

export function numberedInteractionAnswer(
  input: string,
  interactions: readonly InteractionView[],
  owners: readonly string[] | null,
): { readonly requestId: string; readonly decision: WireDecision } {
  const match = /^\/answer\s+(\d+)\s+(\d+)(?:\s+([\s\S]*))?$/.exec(input.trim());
  const interaction = match && interactions[Number(match[1]) - 1];
  const choice = interaction && match && interaction.choices[Number(match[2]) - 1];
  if (!interaction || !choice || !match) throw new Error('Use /answer <interaction number> <choice number> [text].');
  if (owners && owners[Number(match[1]) - 1] !== interaction.id) {
    throw new Error('The interaction list changed. Check the prompt and re-enter your answer.');
  }
  if (interaction.questions?.length) throw new Error('Use Ctrl+G to answer these structured questions.');
  let decision: WireDecision;
  switch (choice.id) {
    case 'allow':
      if (match[3]) throw new Error('Allow does not accept text.');
      decision = { kind: 'allow' };
      break;
    case 'deny':
      decision = { kind: 'deny', ...(match[3] ? { reason: match[3] } : {}) };
      break;
    case 'answer':
      if (!match[3]?.trim()) throw new Error('Enter an answer after the choice number.');
      decision = { kind: 'answer', answer: match[3] };
      break;
    case 'stop':
      if (match[3]) throw new Error('Stop does not accept text.');
      decision = { kind: 'answer', answer: '', stopAfterApprovalResolution: true };
      break;
    default: {
      const grant = interaction.supportedGrants?.find((value) => choice.id === `grant:${value}`);
      if (!grant || match[3]) throw new Error('Unsupported interaction choice or unexpected text.');
      decision = { kind: 'grant', grant };
    }
  }
  return { requestId: interaction.id, decision };
}
