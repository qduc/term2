/** Aggregate the filtered transcripts from run-executed.sh. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
for (const arm of ['deepseek-simple', 'deepseek-gpt', 'luna-gpt', 'luna-simple']) {
  const control = join(root, 'control');
  const events = readFileSync(join(control, `${arm}.run.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
  const records = events.filter((event) => event.type === 'cost_update').map((event) => JSON.parse(event.text).record);
  const tools = events.filter((event) => event.type === 'tool_started');
  const shell = tools.filter((event) => event.name === 'shell');
  const sum = (key) => records.reduce((total, record) => total + (record.usage?.[key] ?? 0), 0);
  console.log(JSON.stringify({
    arm,
    exit: Number(readFileSync(join(control, `${arm}.exit`), 'utf8')),
    seconds: Number(readFileSync(join(control, `${arm}.seconds`), 'utf8')),
    evaluator: readFileSync(join(control, `${arm}.evaluator.status`), 'utf8').trim(),
    final: events.some((event) => event.type === 'final'),
    requests: records.length,
    inputTokens: sum('prompt_tokens'), outputTokens: sum('completion_tokens'),
    cachedInputTokens: sum('cache_read_tokens'),
    catalogUsd: records.every((record) => record.usdMicros !== undefined)
      ? records.reduce((total, record) => total + record.usdMicros, 0) / 1e6 : null,
    tools: tools.length, shellCalls: shell.length,
    validationCommands: shell.map((event) => {
      try { return JSON.parse(event.input).command; } catch { return ''; }
    }).filter((command) => /vitest|typecheck|test:|pnpm test/.test(command)).map((command) => command.slice(0, 180)),
  }));
}
