# Runtime logging

Term2 writes daily JSON logs as `term2-YYYY-MM-DD.log` under the platform's
Term2 log directory. Provider traffic envelopes live in the `provider-traffic`
subdirectory and record the request and response at the provider boundary.
Both are diagnostic files and can contain conversation data. Conversation
persistence has its own [durability contract](../contracts/08-conversation-durability-and-recovery.md).

## Reading application logs

Structured runtime events carry `timestamp`, `level`, `eventType`, and
`messageId`. Correlate with `traceId` and `sessionId` when present. Provider,
model, and tool fields depend on the event. `RuntimeLogSchema` and
`buildRuntimeLogRecord` describe the shape in
[`logging-contract.ts`](../../src/session/logging/logging-contract.ts).

For provider traffic, search for `provider.request.started`,
`provider.response.received`, `provider.response.closed`, or
`provider.response.failed`. The evaluator uses its own event prefix on
request start, response receipt, and response close. The traffic envelope shape
depends on the provider transport. Use its recorded transport metadata before
interpreting the payload. See the
[logging and traffic contract](../contracts/07-logging-and-provider-traffic.md)
for the privacy boundary.

## Logging controls

| Setting or environment | Effect |
| --- | --- |
| `logging.disableLogging`, `DISABLE_LOGGING` | Turn off diagnostic file sinks at logger construction. |
| `logging.logLevel`, `LOG_LEVEL` | Set the application log level. |
| `LOG_CATEGORIES` | Filter on comma-separated categories: `provider`, `tool`, `stream`, `approval`, `retry`, or `general`. Warnings and errors bypass this filter. |
| `LOG_SAMPLE_RATE` | Sample application events at a rate from 0 to 1. Warnings and errors bypass sampling. |
| `LOG_VERBOSE_PAYLOADS` | Include verbose application log payload metadata. Errors can include verbose metadata by default. |
| `TERM2_RAW_TRAFFIC` | Enable raw provider traffic sidecars when diagnostic file sinks are enabled. |

For daemon sessions, use persisted logging settings or set the environment in
the daemon process. Automatic daemon startup forwards `TERM2_*` variables
such as `TERM2_RAW_TRAFFIC`. It omits the unprefixed `LOG_*` variables and
`DISABLE_LOGGING`. See [local daemon operations](local-daemon.md).
