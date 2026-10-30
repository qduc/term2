/** Runs the configured command as-is. Used until sandboxed launch lands. */
export const unsandboxedStdioLauncher = async (spec) => ({
    command: spec.command,
    args: spec.args,
    env: spec.env,
    ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
});
//# sourceMappingURL=mcp-stdio-launcher.js.map