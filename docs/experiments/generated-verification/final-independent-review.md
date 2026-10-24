**REJECT** pending installed-command verification.

`pnpm verify:generated --seed 424242` exits 2 because synchronous Git metadata collection fails with `EPERM`. Asynchronous Git succeeds in the same workspace.

Queue behavior looks sound: 21 focused boundary checks passed, generated properties passed with metadata supplied, and both baseline defects reproduced and replayed correctly. No network calls occurred. Full tiers remain parent-owned.

[Report and retained evidence](docs/experiments/generated-verification/checks/real-use/REPORT.md).