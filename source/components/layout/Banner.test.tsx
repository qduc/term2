// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderInAct } from '../../test-helpers/ink-testing.js';
import { createMockSettingsService } from '../../services/settings/settings-service.mock.js';
import Banner, { resolveDisplayVersion } from './Banner.js';

type Loader = (specifier: string) => unknown;

const loaderReturning = (buildInfo: unknown): Loader => {
  return (specifier) => {
    if (specifier.includes('build-info')) {
      if (buildInfo instanceof Error) throw buildInfo;
      return buildInfo;
    }
    return { version: '1.2.3' };
  };
};

describe('resolveDisplayVersion', () => {
  it('prefers the generated build identity over the package version', () => {
    expect(resolveDisplayVersion(loaderReturning({ version: '1.2.3-dev+abc1234' }))).toBe('1.2.3-dev+abc1234');
  });

  it('falls back to the package version when the build wrote no identity', () => {
    expect(resolveDisplayVersion(loaderReturning(new Error('MODULE_NOT_FOUND')))).toBe('1.2.3');
  });

  it('falls back to the package version when the build identity carries no version', () => {
    expect(resolveDisplayVersion(loaderReturning({ commit: 'abc1234' }))).toBe('1.2.3');
  });
});

it('shows the same version string as cli --version', async () => {
  const { lastFrame } = await renderInAct(<Banner settingsService={createMockSettingsService()} />);

  const shown = /v(\d+\.\d+\.\d+\S*)/.exec(lastFrame() ?? '')?.[1];
  expect(shown).toBe(resolveDisplayVersion());
});
