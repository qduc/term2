import { describe, expect, it } from 'vitest';
import {
  CODENAME_RUN_ID_PATTERN,
  codenameRunIdSpace,
  createCodenameRunId,
  parseCodenameRunId,
} from './codename-run-id.js';

describe('createCodenameRunId', () => {
  it('produces the adjective-noun-number shape every time', () => {
    for (let i = 0; i < 500; i++) {
      const id = createCodenameRunId();
      expect(id).toMatch(CODENAME_RUN_ID_PATTERN);
    }
  });

  it('matches the run-name pattern so a codename runId is also a valid alias', () => {
    // Re-creating the pattern here would duplicate production; assert the shape
    // explicitly against what SUBAGENT_RUN_NAME_PATTERN requires.
    const id = createCodenameRunId();
    expect(id).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  });

  it('keeps every codename under 32 characters', () => {
    for (let i = 0; i < 500; i++) {
      expect(createCodenameRunId().length).toBeLessThanOrEqual(31);
    }
  });

  it('parses back into its three parts', () => {
    const id = 'calm-otter-42';
    expect(parseCodenameRunId(id)).toEqual({ adjective: 'calm', noun: 'otter', number: 42 });
  });

  it('parses a three-digit number suffix', () => {
    const id = 'noble-numbat-999';
    expect(parseCodenameRunId(id)).toEqual({ adjective: 'noble', noun: 'numbat', number: 999 });
  });

  it('returns undefined for a non-codename id', () => {
    expect(parseCodenameRunId('3f250191-82f4-1d13-a712-0a3bef00b6e0')).toBeUndefined();
    expect(parseCodenameRunId('scan')).toBeUndefined();
    expect(parseCodenameRunId('calm-otter')).toBeUndefined();
    expect(parseCodenameRunId('calm-otter-')).toBeUndefined();
  });

  it('expresses an id space large enough that session-wide collisions are negligible', () => {
    // With 90k+ mnemonic pairs × hundreds of numbers this is in the tens of
    // millions; the registry still retries on the theoretical collision.
    expect(codenameRunIdSpace()).toBeGreaterThan(1_000_000);
  });

  it('produces highly varied codenames across a sample', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 2000; i++) ids.add(createCodenameRunId());
    // Random collisions within 2k draws from a multi-million space are expected
    // to be near zero; ordering that no dup appears keeps the test stable while
    // still exercising the generator heavily.
    expect(ids.size).toBeGreaterThan(1900);
  });
});
