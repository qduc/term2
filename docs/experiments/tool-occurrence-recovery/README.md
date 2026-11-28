# Tool occurrence recovery

The pre-rewrite occurrence repair landed in `3b611e52a`. Provider call IDs
correlate protocol calls with results. The host also needs turn and occurrence
identity when a provider reuses an ID. The repair assigned a turn-local ordinal
at admission, before validation, approval, or dispatch, and carried
`(turnId, callId, occurrence)` through saved results and replay. Provider call
IDs and payloads remained stable.

A final assistant envelope identifies its own turn. Matching its untagged calls
by payload against the entire ledger let it borrow an earlier turn's admission
when ID, tool, and arguments repeated. Final-envelope correlation was narrowed
to the envelope's authoritative turn. Accumulated-history reconciliation still
needed conversation-wide alignment. A matched result inherits its call's
occurrence, and an unmatched call and result stay together for ordered pairing.
The distinction matters even when the output payloads happen to be identical.

## Historical verification

The offline probe drove a production coordinator and writer, copied the flushed
journal prefix, reopened through the public replay path, and examined the next
request to a fake model. The retained controls cover prior-turn equal-payload
calls, result ownership, and older records without explicit occurrence fields.
The flush-based probe established neither crash consistency nor provider behavior.

The [original reports and runner](https://github.com/qduc/term2/tree/c455d16c56dfa1d46664c0b3183873100942bf65/docs/experiments/tool-occurrence-recovery) require the
pre-rewrite runtime. Their [archived captures](https://github.com/qduc/term2/tree/v1.3.0/docs/experiments/tool-occurrence-recovery)
record red and green results, test totals, and the four unrelated Bare CLI
sandbox failures reproduced on the comparison base. For a change to current
recovery, use the active runtime and compare both protocol payload and separate
host occurrence identity.
