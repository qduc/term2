import { describe, expect, it } from 'vitest';
import { resolveActiveEnforcement } from './active-profile.js';

describe('resolveActiveEnforcement', () => {
  it.each([undefined, false, 42])('falls back to standard for a non-string active profile id (%s)', (value) => {
    const settings = { get: () => value } as any;

    const enforcement = resolveActiveEnforcement(settings);

    expect(enforcement.policies).toEqual(new Set(['builtin:enforcement/normal']));
    expect(enforcement.denials).toEqual(new Set());
    expect(enforcement.handoffRestrictions).toEqual(new Set());
  });

  it('resolves plan enforcement denials and handoff restriction', () => {
    const settings = { get: () => 'builtin:plan' } as any;

    const enforcement = resolveActiveEnforcement(settings);

    expect(enforcement.policies).toEqual(new Set(['builtin:enforcement/normal', 'builtin:enforcement/plan-read-only']));
    expect(enforcement.denials).toEqual(
      new Set(['filesystem-mutation', 'shell-mutation', 'delegated-write', 'unknown-delegated-role']),
    );
    expect(enforcement.handoffRestrictions).toEqual(new Set(['plan-read-only']));
  });

  it('memoizes enforcement while the active profile id is unchanged', () => {
    let profileId: unknown = 'builtin:standard';
    const settings = { get: () => profileId } as any;

    const first = resolveActiveEnforcement(settings);
    const second = resolveActiveEnforcement(settings);
    profileId = 'builtin:plan';
    const third = resolveActiveEnforcement(settings);

    expect(second).toBe(first);
    expect(third).not.toBe(first);
    expect(third.handoffRestrictions.has('plan-read-only')).toBe(true);
  });

  it('returns empty enforcement for an unknown profile id', () => {
    const settings = { get: () => 'builtin:does-not-exist' } as any;

    expect(resolveActiveEnforcement(settings)).toEqual({
      policies: new Set(),
      denials: new Set(),
      handoffRestrictions: new Set(),
    });
  });
});
