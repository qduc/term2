import { describe, expect, it } from 'vitest';
import { buildToggleConflictNotice, isToolToggleKey, resolveDisabledCapabilities } from './tool-toggles.js';

const reader = (values: Record<string, unknown>) => ({
  getDynamic: (key: string) => values[key],
  get: (key: string) => (key === 'app.activeProfileId' ? values['app.activeProfileId'] : undefined),
});

describe('resolveDisabledCapabilities', () => {
  it('masks nothing when every toggle is at its default (enabled)', () => {
    const values = Object.fromEntries(
      [
        'tools.shell.enabled',
        'tools.web.enabled',
        'tools.fileRead.enabled',
        'tools.fileWrite.enabled',
        'tools.memory.enabled',
        'tools.sessions.enabled',
        'tools.skills.enabled',
        'tools.mentor.enabled',
        'tools.subagents.enabled',
        'tools.backgroundTasks.enabled',
        'tools.userInteraction.enabled',
        'tools.codeContext.enabled',
      ].map((key) => [key, true]),
    );
    expect(resolveDisabledCapabilities(reader(values))).toEqual(new Set());
  });

  it('maps each toggle to its capability group strings', () => {
    expect(resolveDisabledCapabilities(reader({ 'tools.shell.enabled': false }))).toEqual(new Set(['shell']));
    expect(resolveDisabledCapabilities(reader({ 'tools.web.enabled': false }))).toEqual(new Set(['web']));
    expect(resolveDisabledCapabilities(reader({ 'tools.fileWrite.enabled': false }))).toEqual(
      new Set(['filesystem-write']),
    );
    expect(resolveDisabledCapabilities(reader({ 'tools.subagents.enabled': false }))).toEqual(new Set(['subagents']));
  });

  it('fileRead masks both read capabilities together (filesystem-read-external has no separate toggle)', () => {
    expect(resolveDisabledCapabilities(reader({ 'tools.fileRead.enabled': false }))).toEqual(
      new Set(['filesystem-read-workspace', 'filesystem-read-external']),
    );
  });

  it('unions multiple disabled toggles and ignores enabled and unknown values', () => {
    const masked = resolveDisabledCapabilities(
      reader({ 'tools.shell.enabled': false, 'tools.web.enabled': false, 'tools.mentor.enabled': true }),
    );
    expect(masked).toEqual(new Set(['shell', 'web']));
  });
});

describe('isToolToggleKey', () => {
  it('recognizes exactly the twelve toggle keys', () => {
    expect(isToolToggleKey('tools.shell.enabled')).toBe(true);
    expect(isToolToggleKey('tools.codeContext.enabled')).toBe(true);
    expect(isToolToggleKey('tools.logFileOperations')).toBe(false);
    expect(isToolToggleKey('tools.shell')).toBe(false);
    expect(isToolToggleKey('agent.model')).toBe(false);
  });
});

describe('buildToggleConflictNotice', () => {
  it('returns null when nothing was newly disabled', () => {
    expect(buildToggleConflictNotice(reader({ 'app.activeProfileId': 'builtin:lite' }), [])).toBeNull();
  });

  it('warns when a disabled toggle conflicts with the Lite profile', () => {
    const notice = buildToggleConflictNotice(reader({ 'app.activeProfileId': 'builtin:lite' }), [
      'tools.shell.enabled',
    ]);
    expect(notice).toContain('tools.shell.enabled');
    expect(notice).toContain('Lite');
  });

  it('lists every conflicting toggle from one batch in a single notice', () => {
    const notice = buildToggleConflictNotice(reader({ 'app.activeProfileId': 'builtin:lite' }), [
      'tools.shell.enabled',
      'tools.web.enabled',
      'tools.fileRead.enabled',
    ]);
    expect(notice).toContain('tools.shell.enabled');
    expect(notice).toContain('tools.web.enabled');
    expect(notice).toContain('tools.fileRead.enabled');
  });

  it('warns for orchestrator, mentor, standard and plan shell, file-write, or role-specific tools', () => {
    const cases: Array<[string, string[], string]> = [
      ['builtin:orchestrator', ['tools.subagents.enabled'], 'Orchestrator'],
      ['builtin:orchestrator', ['tools.shell.enabled'], 'Orchestrator'],
      ['builtin:orchestrator', ['tools.fileWrite.enabled'], 'Orchestrator'],
      ['builtin:mentor', ['tools.mentor.enabled'], 'Mentor'],
      ['builtin:mentor', ['tools.shell.enabled'], 'Mentor'],
      ['builtin:mentor', ['tools.fileWrite.enabled'], 'Mentor'],
      ['builtin:standard', ['tools.fileWrite.enabled'], 'Standard'],
      ['builtin:standard', ['tools.shell.enabled'], 'Standard'],
      ['builtin:standard', ['tools.subagents.enabled'], 'Standard'],
      ['builtin:plan', ['tools.fileWrite.enabled'], 'Plan'],
      ['builtin:plan', ['tools.shell.enabled'], 'Plan'],
      ['builtin:plan', ['tools.subagents.enabled'], 'Plan'],
    ];
    for (const [profileId, toggles, label] of cases) {
      const notice = buildToggleConflictNotice(reader({ 'app.activeProfileId': profileId }), toggles);
      expect(notice, `${profileId} ${toggles.join(',')}`).toContain(label);
      expect(notice!, `${profileId} ${toggles.join(',')}`).toContain(toggles[0]);
    }
  });

  it('does not warn for non-conflicting combinations', () => {
    expect(
      buildToggleConflictNotice(reader({ 'app.activeProfileId': 'builtin:lite' }), ['tools.codeContext.enabled']),
    ).toBeNull();
    expect(
      buildToggleConflictNotice(reader({ 'app.activeProfileId': 'builtin:orchestrator' }), ['tools.web.enabled']),
    ).toBeNull();
    expect(
      buildToggleConflictNotice(reader({ 'app.activeProfileId': 'builtin:standard' }), ['tools.codeContext.enabled']),
    ).toBeNull();
  });

  it('warns generically for non-builtin profile ids on any disabling change', () => {
    const notice = buildToggleConflictNotice(reader({ 'app.activeProfileId': 'user:my-profile' }), [
      'tools.codeContext.enabled',
    ]);
    expect(notice).toContain('tools.codeContext.enabled');
    expect(notice).toContain('user:my-profile');
  });

  it('never warns for builtin ids that disabled a non-conflicting toggle', () => {
    expect(
      buildToggleConflictNotice(reader({ 'app.activeProfileId': 'builtin:standard' }), ['tools.codeContext.enabled']),
    ).toBeNull();
  });
});
