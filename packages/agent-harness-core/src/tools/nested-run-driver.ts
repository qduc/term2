export interface RunBudgetPolicy {
  readonly maxUsdMicros: number;
  readonly maxUnpricedTokens: number;
  readonly maxActiveTimeMs: number;
  readonly warningHeadroomUsdMicros: number;
  readonly warningHeadroomUnpricedTokens: number;
  readonly warningHeadroomActiveTimeMs: number;
  readonly softHeadroomUsdMicros: number;
  readonly softHeadroomUnpricedTokens: number;
  readonly softHeadroomActiveTimeMs: number;
  readonly turnBackstop: number;
  readonly extensionPercent: number;
  readonly maxParentExtensions: number;
  readonly identicalToolCallThreshold: number;
  /**
   * What a non-soft stage does.
   *
   * `contain` keeps warning/stall advisory and parks at exhaustion. `warn`
   * remains an explicit advisory opt-out; `pause` also parks on warning/stall.
   */
  readonly escalation: 'contain' | 'warn' | 'pause' | 'disabled';
}

export type RunBudgetStage = 'soft' | 'warning' | 'critical';
export type RunBudgetDimension = 'usd' | 'unpriced_tokens' | 'active_time' | 'turns';

export interface RunBudgetEvidence {
  readonly dimension: RunBudgetDimension;
  readonly used: number;
  readonly limit: number;
  readonly headroom: number;
}

export type RunBudgetEvent =
  | { readonly type: 'budget_stage'; readonly stage: RunBudgetStage; readonly evidence: RunBudgetEvidence }
  | {
      readonly type: 'tool_stall';
      readonly toolName: string;
      readonly argumentsText: string;
      readonly count: number;
      readonly threshold: number;
    };
