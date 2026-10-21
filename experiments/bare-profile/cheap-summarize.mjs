import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
const dir = path.resolve(process.argv[2]);
const summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
const runs = summary.records.map((record) => {
  const calls = JSON.parse(fs.readFileSync(path.join(dir, `${record.id}-calls.json`), 'utf8'));
  return {
    id: record.id,
    candidate: record.candidate,
    arm: record.arm,
    tokens: record.tokens,
    stopReason: record.stopReason,
    instrumentError: record.instrumentError,
    calls: calls.map((call) => {
      const frames = (call.rawResponse ?? '')
        .split('\n')
        .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
        .map((line) => JSON.parse(line.slice(6)));
      const tools = new Map();
      for (const frame of frames)
        for (const choice of frame.choices ?? [])
          for (const tool of choice.delta?.tool_calls ?? []) {
            const prior = tools.get(tool.index) ?? { name: '', arguments: '' };
            prior.name += tool.function?.name ?? '';
            prior.arguments += tool.function?.arguments ?? '';
            tools.set(tool.index, prior);
          }
      return {
        sequence: call.sequence,
        dispatched: Boolean(call.dispatched),
        models: call.resolvedModels,
        usage: call.usage,
        error: call.error,
        tools: [...tools.values()],
        finishes: frames.flatMap((frame) =>
          (frame.choices ?? []).map((choice) => choice.finish_reason).filter(Boolean),
        ),
        assistantText: frames
          .flatMap((frame) => (frame.choices ?? []).map((choice) => choice.delta?.content ?? ''))
          .join(''),
        observedToolResults: call.request.messages
          .filter((message) => message.role === 'tool')
          .map((message) => ({
            id: message.tool_call_id,
            text: typeof message.content === 'string' ? message.content.slice(0, 700) : message.content,
          })),
      };
    }),
  };
});
fs.writeFileSync(
  path.join(dir, 'analysis.json'),
  JSON.stringify({ experimentTokens: summary.experimentTokens, runs }, null, 2) + '\n',
);
console.log(JSON.stringify({ experimentTokens: summary.experimentTokens, runs }, null, 2));
