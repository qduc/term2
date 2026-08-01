# Real-traffic fixture provenance

These are sanitized, reviewed wire envelopes. Raw recordings are never committed.
Replay fixtures validate captured provider behavior; they do not replace live canaries
for changes after capture.

- **fixture/tool-continuation-v1.json** — captured 2026-08-01; SDK openai@6.37.0; model family fixture; probe `tool-continuation-v1`; reviewer fixture maintainer. Recapture when the wire family or transport-relevant SDK major/minor changes.

## Recapture

Run `pnpm provider:record --from-fake chat-completions success --provider fixture --model chat-fixture --probe tool-continuation-v1 --out /absolute/private/path`, then run `pnpm provider:fixture:prepare <recording>` and review the generated artifact. Use `--accept` only after checking the placeholder map, response payloads, frame order, and secret-scan result. Live recording additionally requires `--yes`, credentials, and an explicit probe; it is never part of PR tests.
