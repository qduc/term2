// Ignores SIGTERM and never exits on its own, so only SIGKILL or the caller's
// unconditional deadline can end the command.
process.on('SIGTERM', () => {});
process.stdout.write('ignoring-sigterm\n');
setInterval(() => undefined, 1_000);
