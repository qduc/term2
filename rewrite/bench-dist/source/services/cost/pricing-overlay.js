const OPENAI_PRICING_URL = 'https://platform.openai.com/docs/pricing';
const CHECKED_AT = '2026-07-29';
/**
 * Flex service tier: OpenAI charges 50% of standard input/output/cache prices
 * on eligible GPT-5.x models. Only entries verified against the pricing
 * documentation are listed; anything else fails closed.
 */
export const TIER_PRICING_OVERLAY = {
    openai: {
        'gpt-5.4': {
            flex: {
                inputPerMTok: 1.25,
                outputPerMTok: 7.5,
                cacheReadPerMTok: 0.125,
                sourceUrl: OPENAI_PRICING_URL,
                checkedAt: CHECKED_AT,
            },
        },
        'gpt-5.4-mini': {
            flex: {
                inputPerMTok: 0.375,
                outputPerMTok: 2.25,
                cacheReadPerMTok: 0.0375,
                sourceUrl: OPENAI_PRICING_URL,
                checkedAt: CHECKED_AT,
            },
        },
        'gpt-5.5': {
            flex: {
                inputPerMTok: 2.5,
                outputPerMTok: 15,
                cacheReadPerMTok: 0.25,
                sourceUrl: OPENAI_PRICING_URL,
                checkedAt: CHECKED_AT,
            },
        },
    },
};
//# sourceMappingURL=pricing-overlay.js.map