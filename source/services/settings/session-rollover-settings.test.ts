import { describe, expect, it } from 'vitest';
import { AgentSettingsSchema, DEFAULT_SETTINGS } from './settings-schema.js';
import { buildSettingsWithSources } from './settings-sources.js';

describe('session rollover settings', () => {
  it('provides reminder defaults and validates milestone values', () => {
    expect(AgentSettingsSchema.parse({}).sessionRollover).toEqual({
      enabled: true,
      milestones: [200_000, 300_000, 400_000],
      autoBrief: true,
    });
    expect(() => AgentSettingsSchema.parse({ sessionRollover: { milestones: [0] } })).toThrow();
    expect(DEFAULT_SETTINGS.agent.sessionRollover.milestones).toEqual([200_000, 300_000, 400_000]);
  });

  it('maps each reminder setting to its source key', () => {
    const settings = AgentSettingsSchema.parse({});
    const mapped = buildSettingsWithSources(
      { ...DEFAULT_SETTINGS, agent: { ...DEFAULT_SETTINGS.agent, ...settings } },
      (key) => (key === 'agent.sessionRollover.milestones' ? 'config' : 'default'),
    );
    expect(mapped.agent.sessionRollover.milestones).toEqual({
      value: [200_000, 300_000, 400_000],
      source: 'config',
    });
  });
});
