import { normalizeApplicationInput } from '../../../../source/services/agent-runtime/application-run-loop.js';
import { adoptedModelConversion } from '../../model/adopted/index.js';
/** Source events can contain raw provider-opaque outputs as well as source history items. */
export function convertSourceItems(input, provider) {
    if (typeof input === 'string')
        return normalizeApplicationInput(input).map((part) => adoptedModelConversion.inputToItem(part, provider));
    const entries = Array.isArray(input) ? input : [input];
    return entries.flatMap((entry) => {
        if (entry.type === 'provider_opaque' &&
            typeof entry.provider === 'string' &&
            entry.item &&
            typeof entry.item === 'object' &&
            !Array.isArray(entry.item)) {
            return [adoptedModelConversion.outputToItem(entry, provider)];
        }
        return normalizeApplicationInput([entry]).map((part) => adoptedModelConversion.inputToItem(part, provider));
    });
}
//# sourceMappingURL=conversion.js.map