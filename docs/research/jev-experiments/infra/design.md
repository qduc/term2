# P1 runner design

Status: prepared; no smoke or scored provider call has been made.

The shared runner is intentionally a Python-stdlib client rather than a change
to term2's provider path. It measures the OpenRouter alpha Decision API only;
it cannot establish application-level timeout, cancellation, or validation
behaviour. All experiments are Choice top-choice pilots, including retrieval
tasks. They must not claim ranking metrics such as recall@k or NDCG.

The lane owns labels, prompts, and baseline. `infra` owns only the executable
and its mock selftest fixtures. Before a first development request, the runner
writes a lane-local digest manifest. Every record repeats that dataset digest;
freeze rejects a mismatch. This makes later label edits detectable, while still
requiring independent review to establish label validity.

The dev selection score is attempted accuracy: malformed and transport failures
count as wrong. Freeze requires a complete live attempt matrix and retains all
variants. Holdout accepts only the frozen prompt/digests. Reports keep attempted
and answered accuracy separate, preserve transport errors, confusion counts,
per-class recall, latency, and observed usage. Small pilot samples, author-
visible holdouts, synthetic data, and provider-level transport all remain
limitations rather than evidence of production reliability or calibration.

The optional stability command predeclares a narrow ordinary/adversarial subset
after holdout, then tests exact-prompt repetition and criteria-order sensitivity
outside the main metric. It does not make a Score or Noul claim.
