import { describe, expect, it } from 'vitest';
import {
  CODENAME_RUN_ID_PATTERN,
  codenameRunIdSpace,
  createCodenameRunId,
  parseCodenameRunId,
} from './codename-run-id.js';

// A codename runId must stay interchangeable with a user-chosen run alias, so
// it must also satisfy SUBAGENT_RUN_NAME_PATTERN. Re-creating the pattern here
// would duplicate production; assert the shape explicitly instead.
const SUBAGENT_RUN_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

describe('createCodenameRunId', () => {
  it('produces alias-safe adjective-noun-number codenames across a sample', () => {
    // Every property asserted here holds per id, so a fixed sample with exact
    // assertions replaces the former probabilistic 500/2000-draw loops: shape,
    // alias validity, and the 31-character alias ceiling are all checked on
    // every draw.
    for (let i = 0; i < 50; i++) {
      const id = createCodenameRunId();
      expect(id).toMatch(CODENAME_RUN_ID_PATTERN);
      expect(id.length).toBeLessThanOrEqual(31);
      expect(id).toMatch(SUBAGENT_RUN_NAME_PATTERN);
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
});
