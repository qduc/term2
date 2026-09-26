# Codex usage limits and earned reset credits

Research date: 2026-09-20. Scope: account quota windows and earned reset credits exposed by Codex App Server; no credit redemption was performed.

## Documented protocol

Start `codex app-server`; exchange `initialize` and `initialized`. Check `account/read`; use ChatGPT authentication. A missing login can be established with `account/login/start` (`type: "chatgpt"`), awaiting `account/login/completed`.

Read `account/rateLimits/read`:

- `rateLimitsByLimitId`: quota buckets; `rateLimits`: compatibility view. Windows report `usedPercent`, `windowDurationMins`, and `resetsAt` (Unix seconds).
- `rateLimitResetCredits.availableCount`: authoritative count; detail rows may be capped.
- `rateLimitResetCredits: null`: unavailable information. Nested `credits: null`: count only. `credits: []`: details fetched, none available.
- Detail rows expose `id`, `resetType`, `status`, `grantedAt`, nullable `expiresAt`, `title`, and `description`.

Redeem through `account/rateLimitResetCredit/consume`. Supply a nonempty `idempotencyKey` (one UUID per logical attempt; reuse for retries). Optional `creditId` selects a returned credit; omission lets the service choose. Outcomes: `reset` consumed one; `alreadyRedeemed` is idempotent success; `nothingToReset` means no eligible window; `noCredit` means none available. Re-read limits afterward.

Generate schemas from the deployed CLI version; the documentation provides no minimum release for these fields. The public RPC documentation does not specify a numerical eligibility threshold.

Source: [official OpenAI App Server documentation](https://learn.chatgpt.com/docs/app-server), especially Message schema, Authentication, Rate limits, and Earned rate-limit resets.

## Wire shapes

Illustrative messages, not a runnable client. A client must read responses, complete initialization, and verify authentication before reading limits. The consume shape is documentation only and was not sent.

```jsonl
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"quota_probe","version":"1.0.0"}}}
{"method":"initialized","params":{}}
{"id":2,"method":"account/read","params":{"refreshToken":false}}
{"id":3,"method":"account/rateLimits/read"}
```

Consumption request shape (requires an intentional redemption):

```json
{"id":4,"method":"account/rateLimitResetCredit/consume","params":{"idempotencyKey":"<new UUID for this logical attempt>","creditId":"<opaque returned credit ID>"}}
```

## Integration cautions

- Natural quota reset time and earned-credit expiry are separate concepts. A frontend should label both explicitly.
- Do not replace missing information with zero, or derive the available count from the detail array length.
- Do not infer which windows changed from a consume outcome; fetch the resulting account state.
- A desktop tool's local eligibility rule is evidence about that tool, not automatically a universal backend rule.
- Account-specific availability and expiry must come from a current account response; illustrative documentation values do not establish an entitlement.

## Local schema verification

The installed `codex-cli 0.155.1` successfully generated its ordinary, non-experimental TypeScript schema during this research. Both account methods appear in `ClientRequest`. The generated `v2/RateLimitResetCredit.ts` explicitly defines `grantedAt` and `expiresAt` as Unix seconds; `expiresAt: null` means no expiry. Convert numeric timestamps to JavaScript milliseconds before constructing a `Date`.

The generated `v2/GetAccountRateLimitsParams.ts` adds a useful capability not described in the rate-limit section of the web page: `excludeResetCreditDetails: true` skips the separate detail fetch for background polling while retaining the available count. Omitted or false requests details. Use detailed reads when opening a reset-credit view.

Generated `RateLimitResetCreditStatus` values are `available`, `redeeming`, `redeemed`, and `unknown`; `RateLimitResetType` is `codexRateLimits` or `unknown`. Preserve unknown values in presentation rather than assuming every returned record is redeemable. These observations establish availability in the inspected build, not the first release containing the feature.

Local evidence: schema generated into `/tmp/codex-reset-schema.i9J3B2` during this research, especially `v2/RateLimitResetCredit.ts`, `v2/RateLimitResetCreditsSummary.ts`, `v2/GetAccountRateLimitsParams.ts`, and `v2/ConsumeAccountRateLimitResetCreditParams.ts`. This temporary directory is an inspection artifact, not a repository dependency.

## Term2 application point

Term2 currently handles streamed quota windows through `CodexRateLimitInfo` in [streamed-model-turn.ts](../../source/contracts/streamed-model-turn.ts), forwarding `codex.rate_limits` events in `convertCodexRawStream` in [codex-responses-model.ts](../../source/providers/codex-responses-model.ts). `codexRateLimitText` in [StatusBar.tsx](../../source/components/layout/StatusBar.tsx) derives labels from `window_minutes`. Those paths do not define earned reset inventory; a source search found no implementation of the account read or consume RPCs.

A prospective integration should fetch inventory using the account RPC, retain null/count-only/detail distinctions, and provide a separate intentional redemption action with a retained idempotency key. This note records research only; it does not implement that integration.
