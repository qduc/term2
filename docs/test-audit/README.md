# Test audit graph

`graph.yaml` is the source of truth for test-audit evidence and proposed decisions.
Keep measurements and judgments separate: runtime belongs in baseline evidence;
recommendations belong in `decisions`.

## Commands

```bash
pnpm test-audit validate
pnpm test-audit list --domain <domain-id>
pnpm test-audit list --recommendation <recommendation>
pnpm test-audit show <test-id>
pnpm test-audit report
```

Pass `--graph <path>` to inspect a calibration or explorer artifact without replacing
the source graph.

## Records

- `domains`, `suites`, `seams`, and `fixtures` contain `{ id, label }` nodes.
- `risks` additionally require `severity`: `low`, `medium`, `high`, or `critical`.
- `contracts` contain `id`, an observable `statement`, `seamIds`, and `riskIds`.
- `tests` contain `kind`, `id`, repository-relative `file`, `domainId`, `suiteId`,
  one or more `contractIds`, and `fixtureIds`. A `case` record additionally requires
  its test `title`.
- `decisions` contain `testId`, `recommendation`, `confidence`, `reason`, one or
  more evidence statements, `replacementTestIds`, and review `status`.

IDs use lowercase kebab case and are unique within their node type. All references
must resolve. There may be at most one current decision per Test. The validator
rejects a set of deletion candidates that would collectively leave a Behavior
Contract without retained evidence. A deletion candidate with `status: rejected`
keeps its test, so it still counts as retained evidence.

The graph begins empty intentionally. Populate it through the approved calibration
wave rather than pre-classifying tests from filenames or timing alone.

Begin with `kind: file`. Expand a file into `kind: case` records only when individual
tests inside it need different contracts or recommendations. This keeps the initial
inventory proportional without losing the ability to make precise cleanup decisions.
