# Profile M1 apply_patch friction scratch note

## 2026-09-03

- Attempt 1: rejected before execution with `patch must be string; input Unrecognized key: "operations". Received keys: operations`.
- Attempt 2: rejected before execution with `patch must be string; input Unrecognized key: "operations". Received keys: operations`.
- Attempt 3: rejected before execution with `patch must be string; input Unrecognized key: "operations". Received keys: operations`.
- Attempt 4: rejected before execution with `patch must be string; input Unrecognized key: "operations". Received keys: operations`.
- Attempt 5: rejected before execution with `patch must be string; input Unrecognized key: "operations". Received keys: operations`.
- The rejected patches were an add-file patch, a retry of the same add-file patch, a no-op update patch, another add-file patch, and an add-file patch targeting `/tmp/test`; none reached execution.
- No runaway output occurred.
