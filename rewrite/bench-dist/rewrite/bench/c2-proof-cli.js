/** C2-only composition entry: install canonical persistence then run the real CLI. */
import { installNonInteractivePersistenceFactory } from '../../source/non-interactive.js';
import { createProofPersistence } from './c2-proof-persistence.js';
const failureMode = process.env['TERM2_C2_PROOF_FAIL'];
const injectedFailure = failureMode === 'write' ||
    failureMode === 'fsync' ||
    failureMode === 'boundary-write' ||
    failureMode === 'boundary-fsync'
    ? failureMode
    : undefined;
installNonInteractivePersistenceFactory((input) => createProofPersistence(input, {
    ...(process.env['TERM2_C2_PROOF_BARRIER_FILE'] ? { barrierFile: process.env['TERM2_C2_PROOF_BARRIER_FILE'] } : {}),
    ...(process.env['TERM2_C2_PROOF_DECISION_BARRIER_FILE']
        ? { decisionBarrierFile: process.env['TERM2_C2_PROOF_DECISION_BARRIER_FILE'] }
        : {}),
    ...(injectedFailure ? { injectedFailure } : {}),
}));
await import('../../source/cli.js');
//# sourceMappingURL=c2-proof-cli.js.map