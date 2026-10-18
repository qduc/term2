import type { Agent, Message, Report, RunContext } from './contracts.js';

/** One deterministic model–tool loop. Both assembly prototypes use this unchanged. */
export async function runAgent(agent: Agent, input: string, run: RunContext): Promise<Report> {
  const history: Message[] = [{ role: 'user', text: input }];
  let report: Report = { status: 'failed', input };
  run.emit('run.start', agent.name);

  try {
    while (true) {
      run.signal.throwIfAborted();
      run.emit('step.start');
      let stepStatus = 'failed';
      try {
        run.emit('request.prepare');
        const request = await agent.hooks.request.promise({ messages: [...history] }, run);
        run.signal.throwIfAborted();

        run.emit('model.start');
        let response;
        try {
          response = await agent.model(request, run);
          run.signal.throwIfAborted();
          // This prototype accepts whole responses; it does not model streaming.
          history.push({
            role: 'assistant',
            text: response.kind === 'answer' ? response.text : JSON.stringify(response.call),
          });
          run.emit('model.end', { status: 'completed', response });
        } catch (error) {
          run.emit('model.end', { status: run.signal.aborted ? 'cancelled' : 'failed' });
          throw error;
        }

        if (response.kind === 'answer') {
          report = { status: 'completed', input, answer: response.text };
          stepStatus = 'completed';
          break;
        }

        run.emit('tool.start', response.call);
        let toolStatus = 'failed';
        try {
          const invocation = await agent.hooks.tool.promise({ kind: 'pending', call: response.call }, run);
          run.signal.throwIfAborted();
          let result;
          if (invocation.kind === 'settled') {
            result = invocation.result;
          } else {
            run.emit('tool.dispatch', invocation.call);
            result = { text: await agent.execute(invocation.call, run), source: 'executed' as const };
          }
          // Keep known outcomes before testing whether advancement was revoked.
          history.push({ role: 'tool', text: result.text });
          run.emit('tool.result', result);
          toolStatus = result.source;
          run.signal.throwIfAborted();
        } finally {
          run.emit('tool.end', run.signal.aborted && toolStatus === 'failed' ? 'cancelled' : toolStatus);
        }
        stepStatus = 'completed';
      } finally {
        run.emit('step.end', run.signal.aborted ? 'cancelled' : stepStatus);
      }
    }
  } catch (error) {
    report = { status: run.signal.aborted ? 'cancelled' : 'failed', input };
    if (!run.signal.aborted) run.emit('run.error', String(error));
  }

  try {
    await agent.hooks.end.promise(report, run);
  } catch (error) {
    report = { status: 'failed', input };
    run.emit('run.error', `end hook: ${String(error)}`);
  } finally {
    run.emit('run.end', report.status);
  }
  return report;
}
