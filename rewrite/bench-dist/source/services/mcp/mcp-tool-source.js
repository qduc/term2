/** Rejection type for {@link McpToolSource.callTool}. Transport/protocol failures only. */
export class McpCallError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'McpCallError';
    }
}
//# sourceMappingURL=mcp-tool-source.js.map