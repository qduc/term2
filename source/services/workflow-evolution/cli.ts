import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { appendEvent, readLedger } from './ledger.js';
import { digest } from './experiment.js';

export async function main(args: string[]): Promise<void> {
  const [command, file, input, ...extra] = args;
  if (
    !file ||
    extra.length ||
    !['show', 'append', 'hash'].includes(command) ||
    (command === 'append' ? !input : input !== undefined)
  ) {
    throw new Error('Usage: cli.ts show <ledger> | append <ledger> <event.json> | hash <json-file>');
  }
  const result =
    command === 'show'
      ? await readLedger(file)
      : command === 'append'
      ? await appendEvent(file, JSON.parse(await readFile(input, 'utf8')))
      : digest(JSON.parse(await readFile(file, 'utf8')));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
