import envPaths from 'env-paths';
import path from 'node:path';
import { VerificationStore } from './services/completion-verification/store.js';

// Operator-only entry point. It is deliberately absent from model-facing tools.
const [action, taskId, operator, reason, ...extra] = process.argv.slice(2);
if (
  !taskId ||
  extra.length ||
  !['inspect', 'recover'].includes(action ?? '') ||
  (action === 'recover' && (!operator?.trim() || !reason?.trim()))
) {
  process.stderr.write(
    'Usage: node dist/completion-verification-admin.js inspect TASK_ID\n' +
      '       node dist/completion-verification-admin.js recover TASK_ID OPERATOR "REASON"\n',
  );
  process.exitCode = 1;
} else {
  let store: VerificationStore | undefined;
  try {
    store = new VerificationStore(path.join(envPaths('term2').data, 'completion-verification.sqlite'));
    if (action === 'inspect') {
      const record = store.read(taskId);
      if (!record) throw new Error('Unknown verification task');
      process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    } else {
      store.recover(taskId, operator!, reason!);
      process.stdout.write(`Administrative recovery recorded for ${taskId}.\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Administrative recovery failed'}\n`);
    process.exitCode = 1;
  } finally {
    store?.close();
  }
}
