/** Summarize completed candidate events without counting repeated usage updates. */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
const arms = process.env.GRID_MODEL === 'sol' ? ['sol-simple', 'sol-gpt'] : ['deepseek-simple', 'deepseek-gpt', 'luna-gpt', 'luna-simple'];
const rows = [];
for (const task of ['c11-d5-batch-denial-tristate', 'r-settings-secret-display', 'r-retry-abort-backoff']) {
  for (const rep of [1, 2]) {
    const control = join(root, 'runs', task, `rep-${rep}`, 'control');
    for (const arm of arms) {
      const events = readFileSync(join(control, `${arm}.run.jsonl`), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
      const records = events.filter((event) => event.type === 'cost_update').map((event) => JSON.parse(event.text).record);
      const sum = (key) => records.reduce((total, record) => total + (record.usage?.[key] ?? 0), 0);
      const evaluator = join(control, `${arm}.evaluator.status`);
      rows.push({ task, rep, arm,
        exit: Number(readFileSync(join(control, `${arm}.exit`), 'utf8')),
        seconds: Number(readFileSync(join(control, `${arm}.seconds`), 'utf8')),
        evaluator: existsSync(evaluator) ? readFileSync(evaluator, 'utf8').trim() : 'NOT_RUN',
        final: events.some((event) => event.type === 'final'), requests: records.length,
        input: sum('prompt_tokens'), cached: sum('cache_read_tokens'), output: sum('completion_tokens'),
        usd: records.length && records.every((record) => record.usdMicros !== undefined)
          ? records.reduce((total, record) => total + record.usdMicros, 0) / 1e6 : null,
        tools: events.filter((event) => event.type === 'tool_started').length,
      });
    }
  }
}
for (const row of rows) console.log(JSON.stringify(row));
