import { normalizeApplicationInput } from '../../../../source/services/agent-runtime/application-run-loop.js';
import type { ProviderInput, ProviderInputItem } from '../../../../source/contracts/provider-input.js';
import type { StreamedModelTurnOutput } from '../../../../source/contracts/streamed-model-turn.js';
import { adoptedModelConversion } from '../../model/adopted/index.js';
import type { Item } from '../../model/index.js';

/** Source events can contain raw provider-opaque outputs as well as source history items. */
export function convertSourceItems(input: ProviderInput | readonly ProviderInputItem[], provider: string): Item[] {
  if (typeof input === 'string')
    return normalizeApplicationInput(input).map((part) => adoptedModelConversion.inputToItem(part, provider));
  const entries: readonly ProviderInputItem[] = Array.isArray(input) ? input : [input as ProviderInputItem];
  return entries.flatMap((entry) => {
    if (
      entry.type === 'provider_opaque' &&
      typeof entry.provider === 'string' &&
      entry.item &&
      typeof entry.item === 'object' &&
      !Array.isArray(entry.item)
    ) {
      return [adoptedModelConversion.outputToItem(entry as unknown as StreamedModelTurnOutput, provider)];
    }
    return normalizeApplicationInput([entry]).map((part) => adoptedModelConversion.inputToItem(part, provider));
  });
}
