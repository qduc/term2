export class ProfileResolutionError extends Error {
    diagnostics;
    constructor(message, diagnostics = []) {
        super(message);
        this.name = 'ProfileResolutionError';
        this.diagnostics = diagnostics;
    }
}
//# sourceMappingURL=types.js.map