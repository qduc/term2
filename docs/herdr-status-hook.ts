// herdr status reporting hook.
//
// Fixes applied 2026-08-08 (pi@w3:p1 debugging session):
//   1. PER-BOOT SOURCE — reports use source `term2:<pid>` instead of a bare
//      `term2`. herdr keys per-source sequence tracking (`hook_report_sequences`)
//      and release matching on this value, and the bare `term2` source had been
//      poisoned by earlier debugging reports (last seq ~1e15-1e17), so this
//      hook's small seqs (1,2,3,...) were permanently rejected as stale. A
//      per-boot source resets the sequence namespace each launch and isolates
//      concurrent term2 instances. The agent LABEL stays "term2" (what herdr
//      displays); the source is invisible in the agent list.
//   2. WALL-CLOCK SEQ — seq starts at Date.now()*1000 (same scheme as herdr's
//      own pi integration) so reports always advance regardless of prior state.
//   3. DIAGNOSTIC LOGGING — every spawn and its outcome is appended to
//      /tmp/term2-hook-debug.log so hook failures are observable instead of
//      silent (previously spawn errors and nonzero exits were swallowed).
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { Term2Hooks, Term2Status } from '@qduc/term2/hooks';

type HerdrAgentState = 'idle' | 'working' | 'blocked' | 'unknown';

const DEBUG_LOG = '/tmp/term2-hook-debug.log';
const AGENT_LABEL = 'term2';
const SOURCE = `${AGENT_LABEL}:${process.pid}`;

let reportSeq = Date.now() * 1000;

function debug(message: string): void {
  try {
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // no-op
  }
}

function nextSeq(): number {
  reportSeq += 1;
  return reportSeq;
}

function reportToHerdr(args: readonly string[]): Promise<void> {
  return new Promise((resolve) => {
    debug(`spawn herdr ${args.join(' ')}`);
    const child = spawn('herdr', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', (err) => {
      debug(`spawn error: ${err.message}`);
      resolve();
    });
    child.once('close', (code) => {
      const stderrTail = stderr ? ` stderr=${JSON.stringify(stderr.slice(0, 500))}` : '';
      debug(`close code=${code}${stderrTail}`);
      resolve();
    });
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

    debug(`session.start sessionId=${event.sessionId} mode=${event.mode} pane=${paneId} source=${SOURCE}`);

    await reportToHerdr([
      'pane',
      'report-agent-session',
      paneId,
      '--source',
      SOURCE,
      '--agent',
      AGENT_LABEL,
      '--agent-session-id',
      event.sessionId,
      '--seq',
      String(nextSeq()),
    ]);

    await reportToHerdr([
      'pane',
      'report-agent',
      paneId,
      '--source',
      SOURCE,
      '--agent',
      AGENT_LABEL,
      '--state',
      'idle',
      '--agent-session-id',
      event.sessionId,
      '--seq',
      String(nextSeq()),
    ]);
  });

  term2.on('status.change', (event) => {
    const paneId = process.env.HERDR_PANE_ID;
    if (!paneId) return;

    const state = toHerdrState(event.current);
    debug(`status.change ${event.previous}->${event.current} (herdr ${state}) reason=${event.reason}`);

    void reportToHerdr([
      'pane',
      'report-agent',
      paneId,
      '--source',
      SOURCE,
      '--agent',
      AGENT_LABEL,
      '--state',
      state,
      '--agent-session-id',
      event.sessionId,
      '--seq',
      String(nextSeq()),
    ]);
  });

  term2.on('session.end', async () => {
    const paneId = process.env.HERDR_PANE_ID;
    if (!paneId) return;

    debug('session.end releasing agent');
    await reportToHerdr([
      'pane',
      'release-agent',
      paneId,
      '--source',
      SOURCE,
      '--agent',
      AGENT_LABEL,
      '--seq',
      String(nextSeq()),
    ]);
  });
}
