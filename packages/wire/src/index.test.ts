import { describe, expect, it } from 'vitest';
import { FROZEN_AGENT_EVENT_TYPES } from '../../../source/gateway/persistence/contracts.js';
import { AGENT_EVENT_TYPES } from './index.js';

describe('agent wire event contract', () => {
  it('exports the current frozen event-type set', () => {
    expect(new Set(AGENT_EVENT_TYPES)).toEqual(new Set(FROZEN_AGENT_EVENT_TYPES));
  });
});
