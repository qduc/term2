# Observer abandonment reproduction

This supplementary lifecycle probe overrides the public attempt seam, uses the
production root observer, and observes cleanup through an inner generator's
`finally`. It is not a provider or complete user-workflow test; the retained
built-CLI black-box scenario supplies that evidence.

The first observer wrapper failed this probe: after returning the first observer,
`cleaned` remained zero and opening the second turn threw
`A conversation turn is already active`. The narrow fix closes the retained task
when an observation is abandoned; a normal approval wait deliberately keeps it.

The same probe passed after the fix and was rerun against the final built output.
Final output:

```text
PASS: abandoned observation closes inner task; successor starts; both finalizers run
```

Run from the worktree after building:

```sh
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import {TurnWorkflow} from './dist/services/session/turn-workflow.js';
let cleaned = 0;
class ProbeWorkflow extends TurnWorkflow {
  async *executeInitialAttempt() {
    try {
      yield {type: 'text_delta', text: 'first'};
      return {kind: 'response', text: 'done'};
    } finally { cleaned++; }
  }
}
const workflow = new ProbeWorkflow({batchCoordinator: {}, agentClient: {}});
const first = workflow.executeInitial('one');
assert.equal((await first.next()).value.text, 'first');
await first.return({kind: 'stale'});
assert.equal(cleaned, 1, 'abandoned observer must close inner task');
const second = workflow.executeInitial('two');
assert.equal((await second.next()).value.text, 'first');
await second.return({kind: 'stale'});
assert.equal(cleaned, 2);
console.log('PASS: abandoned observation closes inner task; successor starts; both finalizers run');
NODE
```
