import { spawn } from 'node:child_process';
import type { Term2Hooks, Term2Status } from '@qduc/term2/hooks';

type HerdrAgentState = 'idle' | 'working' | 'blocked' | 'unknown';

let sequence = 0;

function reportToHerdr(args: readonly string[]): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn('herdr', args, { stdio: 'ignore' });
    child.once('error', () => resolve());
    child.once('close', () => resolve());
  });
}

function toHerdrState(status: Term2Status): HerdrAgentState {
  switch (status) {
    case 'idle':
      return 'idle';
    case 'working':
      return 'working';
    case 'waiting_for_user':
    case 'waiting_for_approval':
      return 'blocked';
  }
}

export default function register(term2: Term2Hooks): void {
  term2.on('session.start', async (event) => {
    const paneId = process.env.HERDR_PANE_ID;
    if (!paneId) return;

    await reportToHerdr([
      'pane',
      'report-agent-session',
      paneId,
      '--source',
      'term2',
      '--agent',
      'term2',
      '--agent-session-id',
      event.sessionId,
      '--seq',
      String(++sequence),
    ]);

    await reportToHerdr([
      'pane',
      'report-agent',
      paneId,
      '--source',
      'term2',
      '--agent',
      'term2',
      '--state',
      'idle',
      '--agent-session-id',
      event.sessionId,
      '--seq',
      String(++sequence),
    ]);
  });

  term2.on('status.change', (event) => {
    const paneId = process.env.HERDR_PANE_ID;
    if (!paneId) return;

    void reportToHerdr([
      'pane',
      'report-agent',
      paneId,
      '--source',
      'term2',
      '--agent',
      'term2',
      '--state',
      toHerdrState(event.current),
      '--agent-session-id',
      event.sessionId,
      '--seq',
      String(++sequence),
    ]);
  });

  term2.on('session.end', async () => {
    const paneId = process.env.HERDR_PANE_ID;
    if (!paneId) return;

    await reportToHerdr([
      'pane',
      'release-agent',
      paneId,
      '--source',
      'term2',
      '--agent',
      'term2',
      '--seq',
      String(++sequence),
    ]);
  });
}
