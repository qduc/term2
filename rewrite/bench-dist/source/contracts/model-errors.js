/** Application-owned model failure used for retry classification. */
export class ModelBehaviorError extends Error {
    name = 'ModelBehaviorError';
    constructor(message, options) {
        super(message, options);
    }
}
/** Accepts legacy provider errors without importing the legacy SDK. */
export function isModelBehaviorError(error) {
    if (error instanceof ModelBehaviorError)
        return true;
    const value = error;
    return value?.name === 'ModelBehaviorError' || value?.constructor?.name === 'ModelBehaviorError';
}
//# sourceMappingURL=model-errors.js.map