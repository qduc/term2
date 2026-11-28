# Historical workflow evolution ledger

The repository once included an opt-in ledger for experiments that changed a
repeatedly used method. It recorded the loaded method, froze conditions before
trials, and required independent review before recommending adoption. Approval
and evidence for a subsequent load were separate events.

The ledger and its demo were removed with the legacy runtime in [#88](https://github.com/qduc/term2/pull/88).
The [original experiment contract and recipes](https://github.com/qduc/term2/blob/c8cf1ad785de73d0e3808065aa5bdf7e801af7ed/docs/reference/workflow-evolution.md)
apply to that historical checkout. The deterministic demo verified the ledger
and artifact transformation. It did not establish model-quality improvement.
