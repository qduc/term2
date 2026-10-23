# Delegable Implementation Tasks

Ordered by dependency. Each is independently scoped so you can hand them to separate agents/contributors.

---

## Task 1: Dataset schema + seed cases (Done)

**Deliverable:** `eval/auto-approval/dataset.yaml` (or `.json`) + schema doc.

**Scope:**
- Define the case record shape (id, command, history, expected, category, severity, notes, tags, labeler).
- Write 30–50 seed cases covering all 12 categories from the design. Balance roughly: 30% safe, 30% malicious-obvious/exfil/remote-exec, 25% gray-zone + context-misalignment, 15% chain/substitution/encoded/prompt-injection.
- Include a short `README.md` explaining each category with one example.

**Done when:** schema is frozen, cases validate against it, every category has ≥5 entries, ≥10 cases are tagged `severity: critical`.

**Out of scope:** runner, metrics, any code execution.

---

## Task 2: Dataset loader + validator

**Deliverable:** `source/scripts/eval-auto-approval/dataset.ts`.

**Scope:**
- Parse the dataset file.
- Validate against schema (zod or similar). Fail loudly on malformed cases.
- Expose `loadDataset(path): Case[]` and `filterDataset(cases, {category?, severity?, ids?})`.
- Unit tests against a tiny fixture.

**Depends on:** Task 1 schema (not full dataset — just the shape).

---

## Task 3: Runner core

**Deliverable:** `source/scripts/eval-auto-approval/runner.ts`.

**Scope:**
- CLI entry: `--model`, `--provider`, `--dataset`, `--filter`, `--concurrency`, `--repeat`, `--output`, `--dry-run`.
- Env-var guard (`RUN_LIVE_EVAL=1`) + cost estimate printed before execution, with a confirm prompt unless `--yes`.
- For each case × model × repeat: call the real `evaluateShellAutoApprovalAdvisories` (single-command batch) with a real `agentClient`. Record `predicted`, `reasoning`, `latencyMs`, `rawResponse`, `timestamp`, `error`.
- Concurrency via a simple pool; retry transient API errors once.
- Stream results to the output file as they arrive (don't buffer — crash-resilient).

**Depends on:** Task 2.

**Out of scope:** metrics computation, reporting.

---

## Task 4: Response cache

**Deliverable:** On-disk cache keyed by `hash(model + provider + prompt + command + history)`.

**Scope:**
- Wrap the runner's API call. Cache hits skip the API.
- Cache location: `eval/auto-approval/.cache/`. Gitignored.
- `--no-cache` and `--clear-cache` flags.

**Depends on:** Task 3. Can be layered in after Task 3 lands.

---

## Task 5: Metrics computation

**Deliverable:** `source/scripts/eval-auto-approval/metrics.ts`, pure functions.

**Scope:**
- Input: results file. Output: structured metrics object.
- Compute: accuracy, precision, recall, F1, false-approve rate, false-reject rate, parse-error rate, latency percentiles, per-category confusion matrices, flip rate (if repeats > 1).
- Identify "critical failures": false-approves on `severity: critical` cases.
- Unit-tested with synthetic result fixtures — no API calls.

**Depends on:** Task 3's result file format (agree on it upfront).

---

## Task 6: Report generator

**Deliverable:** `source/scripts/eval-auto-approval/report.ts` + CLI `eval-auto-approval report <results.json>`.

**Scope:**
- Render the Markdown report shown in the design (overall / by-category / critical-failures sections).
- Optional `--compare <baseline.json>` flag that diffs two runs and highlights regressions.
- Unit tests on snapshot fixtures.

**Depends on:** Task 5.

---

## Task 7: npm script + documentation

**Deliverable:** `package.json` script + `eval/auto-approval/README.md`.

**Scope:**
- `npm run eval:auto-approval` wired to the runner.
- README: how to run, how to add cases, how to interpret the report, cost expectations, why this isn't in CI.
- Document the `RUN_LIVE_EVAL` guard and cache behavior.

**Depends on:** Tasks 3, 6.

---

## Task 8 (optional, later): Baseline run + findings report

**Deliverable:** A results file + a written analysis doc (not code).

**Scope:**
- Run the harness against the current prompt with the current default auto-approve model + one smaller and one larger model for comparison.
- Write a short findings doc: top 5 prompt weaknesses surfaced, ranked by severity, with example failures.
- This doc is the input for the *next* piece of work (prompt iteration), which is out of scope here.

**Depends on:** Everything above.

---

## Suggested parallelization

- **Wave 1 (parallel):** Task 1 (dataset) + Task 3 skeleton using a stub dataset.
- **Wave 2 (parallel):** Task 2, Task 5 — both depend only on agreed-upon schemas.
- **Wave 3:** Task 4, Task 6, Task 7.
- **Wave 4:** Task 8.
