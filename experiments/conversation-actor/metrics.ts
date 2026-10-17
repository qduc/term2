import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
// A declared comparison basket, NOT all of Term2 and NOT equivalent scope.
const paths = [
  'source/services/queue/queue-controller.ts',
  'source/services/conversation/conversation-adapter.ts',
  'source/services/session/turn-status-machine.ts',
  'source/services/session/turn-coordinator.ts',
  'source/services/session/turn-workflow.ts',
  'source/services/agent-runtime/turn-input-mailbox.ts',
  'source/services/agent-runtime/application-run-loop.ts',
  'source/services/provider-continuity.ts',
  'source/services/session/session-input-planner.ts',
  'source/services/tool-execution-ledger.ts',
  'source/services/retry/recovery-executor.ts',
];
const count = (path: string) => {
  const text = readFileSync(resolve(root, path), 'utf8');
  const lines = text.trimEnd().split('\n');
  return { path, physical: lines.length, nonblank: lines.filter((line) => line.trim()).length };
};
console.log(
  JSON.stringify(
    {
      baseline: '36d30a5c',
      caveat:
        'Descriptive size only: production files include capabilities absent from the prototype. No percentage reduction or parity claim.',
      prototype: ['actor.ts', 'simulate.ts', 'metrics.ts'].map((path) =>
        count(`experiments/conversation-actor/${path}`),
      ),
      productionBasket: paths.map(count),
    },
    null,
    2,
  ),
);
