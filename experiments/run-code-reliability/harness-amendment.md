# Pre-provider harness amendment

The first launch at revision `2b86881eb425ed0bcd51f42e247b25404266ce0c`
failed with Node heap exhaustion (exit 134 after 21.518 seconds). The directory
inventory recursed using the same physical directory and a growing logical
prefix. The first fixture includes a nested website directory and exposed it.
Both initial scratch copies exist, but neither has a manifest or invocation
record. These are written before spawn. No trial CLI/provider was launched;
post-exit process inspection found no study child process. This failed launch
is retained under `evidence/trials/` and is not an efficacy observation.

The corrected harness uses Node's recursive directory enumeration in a separate
inventory module; there is no hand-written recursion or independently evolving
physical/logical traversal state. The deterministic preflight now exercises
nested files and rejects symlinks in the inventory. Both runner inventory
callers use this same module. No candidate, task, oracle, model, metric,
ordering, deadline or success threshold changed. The first frozen protocol's
no-replacement rule is not used to replace a trial: zero trials launched.
The corrected harness is committed before the first provider invocation and
uses a distinct output directory. This does not erase the failed launch or
justify tuning after any model observation.

## Proportional retrospective

Independent reviewer `codex/gpt-6.1-sol`, fresh agent
`run_code_bridge_87:agent:1`, accepted the corrected launch before providers.
It inspected failed-launch artifacts and pre-spawn ordering, the new inventory,
v2 preflight and unchanged protocol against the retained frozen copy. It found
no concrete blocker. Limit: it did not rerun probes or recompute Git blob hashes;
post-exit process absence was parent-observed testimony. Launch conditions:
commit this repair before invoking providers and use a new output directory.

Preventable, latent in the original draft and frozen commit: a recursion typo
was representable because physical and logical paths were separate state.
Single source of truth: replaced both traversal states with native recursive
Dirents. Boundary: preflight previously proved the tool runtime, not the runner
filesystem path. Implicit coupling: nested fixtures required an unexercised
inventory branch. Wrong assumption: reviewing the traversal was sufficient.
Detection/automation: no executed check covered nested inventory; now the
filesystem preflight does. Siblings: two runner calls, one shared implementation,
both checked. Knowledge: a reviewer could have spotted the typo, but lacked
executed runner-path evidence. Observability: first real launch surfaced it in
22 seconds; the new deterministic probe surfaces it before any providers.
Origin: latent since first draft, not a production regression. No production
runtime behavior changed. Further framework or static-rule work is not warranted.
