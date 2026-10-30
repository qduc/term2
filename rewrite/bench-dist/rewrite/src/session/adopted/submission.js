import { normalizeUserTurn } from '../../../../source/types/user-turn.js';
import { normalizedBodyHash } from './conversation-log.js';
/** Own the normalized input before any asynchronous admission work. */
export function captureAdoptedInput(input) {
    const normalized = normalizeUserTurn(input);
    const owned = {
        ...normalized,
        ...(normalized.images ? { images: normalized.images.map((image) => ({ ...image })) } : {}),
        ...(normalized.skill ? { skill: { ...normalized.skill } } : {}),
    };
    return { input: owned, hash: `adopted-user-turn-v1:${normalizedBodyHash(owned)}` };
}
//# sourceMappingURL=submission.js.map