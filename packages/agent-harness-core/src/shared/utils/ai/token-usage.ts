export interface NormalizedUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  reasoning_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  prompt_ms?: number;
  completion_ms?: number;
  tokens_per_second?: number;
  /** True when tokens_per_second is a hedge (hidden tokens likely in the numerator). */
  tokens_per_second_estimated?: boolean;
  /**
   * True when the settled rate exceeded MAX_PLAUSIBLE_DECODE_TPS: it measures
   * a burst or tail window, not sustained decode, so the footer hides it.
   * Carried like tokens_per_second (latest wins, never summed).
   */
  tokens_per_second_burst?: boolean;
  ttft_ms?: number;
  upstream_provider?: string;
}
