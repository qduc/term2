# Outcome: blocked before live execution

The cache-affinity hypothesis remains **inconclusive and untested live**.
Control n=0, treatment n=0, physical live requests=0. There are no measured live
cache-token, latency, request-count or cost comparisons. Paid spend, native-usage
estimated spend and uncertain exposure are each $0; the $100 total cap is untouched.

PR271 head was independently fetched and verified as
`b1c2e4df329a371d2867f4224ba72ca83220e8a4`. Frozen experiment harness commit:
`86f466f4357f1ad9970c08f13445ac58bee4b411`; no product-source/package/lock/script
changes relative to PR271. A fresh build at that harness commit passed provenance
verification. Existing native provider-affinity integration: 9/9 passed locally.

The final three scripted CLI/SDK/HTTP loopback fixtures passed baseline, affinity,
baseline-after; fixture build receipt is at PR271 head. The later harness commit
changes only experiment files; no build-source change. Their normalized initial
request bodies were equal except independent cache keys. The explicit Session-Id
was present only in treatment; request bytes were forwarded unchanged. Synthetic
usage counters and fixture timing are not live-provider results or actual charges.
Frozen coding graders are not run against live artifacts because no live artifact
exists. Sandbox isolation probe passed outside the nested command sandbox.

Independent preflight accepted the meter/header isolation and demonstrated:
concurrent upstream refusal; missing-usage $0.582 reserve retained; same-process
and restarted campaign halt; pre-dispatch cap refusal; no treatment leakage.
Review found and prompted fixes to resumed-ledger halting and artifact retention.
See independent-preflight.json. No hosted CI is claimed. Local build, focused
integration, experiment ESLint, formatting and no-unit-tests guard passed.

Two live process launches were rejected by automatic approval review **before
process creation**. First rejection said paid usage/disclosure lacked user-authored
authorization. The original paid-call approval, $100 answer and separate-session
approval were then verified through user_message_read.read_messages. Exactly one
retry followed this materially new evidence. Review again denied the same action:
although paid API experimentation up to $100 was explicitly approved, export of
private repository/task contents to an external provider was not specified.
No further attempt or alternate execution route was used. The live directory
contains only the initial authorization/budget file: no active lock, physical
ledger, requests, outcomes or pending process. The operation is **denied**, not
pending or uncertain.

Next step: obtain explicit approval naming the payload (the three frozen synthetic
coding tasks plus Term2's shipped prompt/tool definitions) and destination
`https://api.openai.com/v1/responses`, then have the parent request continuation
under the same total $100 cap. Rebuild at the delivered commit and verify provenance
before resuming the fixed six-pair protocol. Do not change credentials/accounts,
rerun a denied operation indirectly, merge, deploy or enable a production default.

Reproducible no-cost evidence is in fixtures-evidence.zip and SHA256SUMS. Client
state/cache, credentials and encrypted reasoning are excluded; script sources and
checksums allow inspection of all retained controls. The durable zero-spend ledger
is spend-ledger.json. No causal savings, routing benefit or capability-equivalence
claim can be made from fixtures.
