import process from 'node:process';
import console from 'node:console';
import { URL } from 'node:url';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startSupervised } from './supervisor.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    prompt: { type: 'string' },
    lock: { type: 'string' },
    entry: { type: 'string', default: fileURLToPath(new URL('../../dist/cli.js', import.meta.url)) },
    import: { type: 'string', multiple: true },
  },
});
if (!values.prompt || !values.lock)
  throw new Error(
    'Usage: node tools/supervised-term2/launch.mjs --prompt FILE --lock DIRECTORY [--entry FILE] [--import FILE] -- TERM2_ARGS',
  );
try {
  const worker = await startSupervised({
    entry: values.entry,
    args: positionals,
    promptFile: values.prompt,
    lockDir: values.lock,
    imports: values.import,
  });
  const result = await worker.completed;
  process.exitCode = result.code ?? (result.signal ? 1 : 0);
} catch (error) {
  // Admission and ownership diagnostics contain no prompt, arguments, or credentials.
  console.error(`${error.code ?? 'supervisor_failed'}: ${error.message}`);
  process.exitCode = 1;
}
