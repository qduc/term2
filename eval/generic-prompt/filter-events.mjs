/** Keep an auditable, bounded transcript without cumulative reasoning_delta.fullText. */
import { createInterface } from 'node:readline';
import { createReadStream, createWriteStream } from 'node:fs';

const input = process.argv[2] ? createReadStream(process.argv[2]) : process.stdin;
const output = process.argv[3] ? createWriteStream(process.argv[3], { flags: 'wx' }) : process.stdout;

for await (const line of createInterface({ input })) {
  const type = /"type":"([^"]+)"/.exec(line.slice(0, 100))?.[1];
  if (!['tool_started', 'tool_dispatched', 'usage_update', 'cost_update', 'final', 'error', 'command_message'].includes(type)) continue;
  const event = JSON.parse(line);
  if (type === 'tool_started' || type === 'tool_dispatched') {
    output.write(JSON.stringify({ type, name: event.name ?? event.toolName,
      input: JSON.stringify(event.input ?? event.args ?? event.arguments ?? '').slice(0, 1200) }) + '\n');
  } else if (type === 'command_message') {
    output.write(JSON.stringify({ type, message: JSON.stringify(event).slice(0, 1200) }) + '\n');
  } else {
    output.write(JSON.stringify({ type, usage: event.usage, cost: event.cost,
      text: JSON.stringify(event).slice(0, 2000) }) + '\n');
  }
}
if (output !== process.stdout) await new Promise((resolve) => output.end(resolve));
