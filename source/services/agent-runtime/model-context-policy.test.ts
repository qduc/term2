import { expect, it } from 'vitest';
import { resolveModelContextPolicy, resolveOutputAllocation } from './model-context-policy.js';
it('separates capacity, actual output, reserve, soft reduction and hard admission', () => {
  expect(resolveModelContextPolicy({ contextWindow: 1000000, maxOutputTokens: 32000 })).toMatchObject({
    capacity: 1000000,
    outputReserve: 32000,
    estimationReserve: 100000,
    hardInputLimit: 868000,
    softTrigger: 781200,
  });
  expect(resolveModelContextPolicy({ contextWindow: 32000, maxOutputTokens: 8000 })).toMatchObject({
    hardInputLimit: 20800,
    softTrigger: 18720,
  });
});
it('keeps explicit input ceilings opt-in and raw triggers subordinate to hard admission', () => {
  expect(
    resolveModelContextPolicy({ contextWindow: 1000000, maxOutputTokens: 32000, inputLimit: 96000 }),
  ).toMatchObject({ hardInputLimit: 96000, softTrigger: 72000 });
  expect(resolveModelContextPolicy({ contextWindow: 32000, maxOutputTokens: 8000, rawTrigger: 90000 })).toMatchObject({
    hardInputLimit: 20800,
    softTrigger: 18720,
  });
});
it('does not invent unknown capacity from a raw trigger or subtract output from an input ceiling', () => {
  expect(resolveModelContextPolicy({ rawTrigger: 40000, maxOutputTokens: 32000 })).toMatchObject({
    hardInputLimit: undefined,
    softTrigger: 40000,
    capacity: undefined,
  });
  expect(resolveModelContextPolicy({ inputLimit: 50000, maxOutputTokens: 32000 })).toMatchObject({
    hardInputLimit: 50000,
    softTrigger: 37500,
  });
  expect(resolveModelContextPolicy({})).toMatchObject({ hardInputLimit: undefined, softTrigger: undefined });
});
it('allocates default output for small windows without overwriting explicit output preferences', () => {
  expect(resolveOutputAllocation({ contextWindow: 8192, maxTokens: 8192 }, 32000, true)).toBe(2048);
  expect(resolveOutputAllocation({ contextWindow: 8192, maxTokens: 8192 }, 6000, false)).toBe(6000);
  expect(resolveOutputAllocation({ contextWindow: 1000000, maxTokens: 100000 }, 32000, true)).toBe(32000);
});

it('honors the smaller ratio and raw trigger in either direction', () => {
  expect(
    resolveModelContextPolicy({ contextWindow: 1000000, maxOutputTokens: 32000, ratio: 0.2, rawTrigger: 900000 })
      .softTrigger,
  ).toBe(200000);
  expect(
    resolveModelContextPolicy({ contextWindow: 1000000, maxOutputTokens: 32000, ratio: 0.8, rawTrigger: 100000 })
      .softTrigger,
  ).toBe(100000);
});
