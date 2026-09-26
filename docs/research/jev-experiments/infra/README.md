# Jev Choice pilot runner

`runner.py` is shared infrastructure for provider-level, Choice-only Jev
screening pilots. It is not a term2 integration test and it does not authorize
any production policy.

## Lane interface

Each lane owns a distinct artifact directory containing `dataset.json` and
`prompts.json`. The positional `LANE` argument is that directory's absolute
path, **not** a task prefix. The runner writes only result and freeze artifacts
in that same directory. It never reads lane data from `infra/`.

```sh
python3 /home/qduc/term2/docs/research/jev-experiments/infra/runner.py validate LANE
python3 /home/qduc/term2/docs/research/jev-experiments/infra/runner.py dev LANE
python3 /home/qduc/term2/docs/research/jev-experiments/infra/runner.py freeze LANE
python3 /home/qduc/term2/docs/research/jev-experiments/infra/runner.py holdout LANE
python3 /home/qduc/term2/docs/research/jev-experiments/infra/runner.py stability LANE
python3 /home/qduc/term2/docs/research/jev-experiments/infra/runner.py report LANE
```

`dev` submits each development case under `minimal`, `rubric`, and `scoped`.
`freeze` requires every case/variant to have one recorded live attempt; failed
attempts remain in the attempted denominator, so a partial or failure-only run
cannot silently select a variant. Equal accuracies select `scoped`, then
`rubric`, then `minimal`. `holdout` refuses dataset or prompt changes after
freeze and submits the selected prompt only. There are no automatic retries:
an existing phase/case/variant record consumes that tuple.

`stability` is optional and only runs after a successful complete holdout. It
first writes `stability-plan.json`, selecting the first ordinary and first
adversarial holdout case per task. It then sends one frozen-prompt repeat and
one request with criteria insertion order reversed. Those records are kept in
`results/stability.jsonl` and excluded from main accuracy.

`smoke LANE` can make one neutral request when explicitly directed. It writes
`smoke.json`; no scored calls or smoke request have been made by this artifact.

## Data contract and wire safety

`dataset.json` is an array of cases with unique `id`, `task`, `split`, object
`state`, `criteria`, `expected`, `rationale`, `provenance`, `tags`, and
`baseline`. `provenance` may be a nonempty string or structured nonempty
object. Every task needs at least 24 dev and 24 holdout cases. `prompts.json`
is keyed by task and supplies all three variants. Validation checks these
structural requirements and split-state separation.

Provider bodies are exactly `{model, state, questions}`. Only `state`, the
selected prompt instructions, and `criteria` enter the body: case ID, task,
split, expected label, baseline, tags, rationale, and provenance do not. The
body is serialized without key sorting so the reversed-order trial is real;
the logged `payload_sha256` hashes those exact HTTP bytes. Every live record
has dataset and prompts digests, start/end timestamps, model, body, status, HTTP status,
raw response (including distributions if supplied), provider ID/model when
supplied, duration, and actual usage when supplied. The credential is used only
in the request header and exact credential-value redaction is applied before a
response is stored.

The runner uses `OPENROUTER_API_KEY`, or reads only
`agent.openrouter.apiKey` in term2's configured settings file in-process. It
does not print or save either credential. It pins `typesafe/jev-1.13`, sends
to `https://openrouter.ai/api/alpha/decisions`, enforces a 60-second per-call
timeout, and uses at most four workers.

## Local verification

```sh
python3 /home/qduc/term2/docs/research/jev-experiments/infra/runner.py selftest
```

The selftest is explicit mock-fixture protocol coverage, not provider evidence.
`build_dataset.py` supplies only those mock fixtures and never writes lane data.

## Independent challenge runner

`challenge_runner.py` is isolated from the active common runner. It imports the
verified payload and `evaluate` helpers but does not alter `runner.py`. It reads
the independently authored challenge artifact by default and has no dev tuning
or prompt selection path: all 80 cases use their preregistered `scoped`
instructions.

```sh
python3 /home/qduc/term2/docs/research/jev-experiments/infra/challenge_runner.py prepare
python3 /home/qduc/term2/docs/research/jev-experiments/infra/challenge_runner.py run
python3 /home/qduc/term2/docs/research/jev-experiments/infra/challenge_runner.py selftest
```

`prepare` makes no API request. It validates exactly four uniquely identified
holdout cases for each of D1--D6, R1--R6, and E1--E8; enforces the
`independent_challenge` tag and valid Choice labels/prompts/provenance; and
writes an immutable digest manifest. `run` rejects a missing or changed
manifest, submits only unrecorded scoped tuples at max concurrency four, and
appends the verified runner's raw record format to `results/challenge.jsonl`.
The mock selftest creates only temporary fixture data and performs no network
request.
