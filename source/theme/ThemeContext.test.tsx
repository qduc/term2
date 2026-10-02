// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { describe, expect, it } from 'vitest';
import React, { act } from 'react';
import { Text } from 'ink';
import { renderInAct } from '../test-helpers/ink-testing.js';
import { createMockSettingsService } from '../services/settings/settings-service.mock.js';
import { THEMES } from './palettes.js';
import { SettingsThemeProvider, ThemeProvider, useTheme } from './ThemeContext.js';

/** Renders the active theme's name and a distinguishing colour as plain text. */
const Probe = () => {
  const theme = useTheme();
  return (
    <Text>
      {theme.name}:{String(theme.userText)}
    </Text>
  );
};

const frameOf = (view: { lastFrame: () => string | undefined }) => view.lastFrame() ?? '';

describe('useTheme', () => {
  it('falls back to the dark theme with no provider, so unwrapped components keep today’s look', async () => {
    const view = await renderInAct(<Probe />);
    expect(frameOf(view)).toBe(`dark:${THEMES.dark.userText}`);
  });

  it('returns the theme given to ThemeProvider', async () => {
    const view = await renderInAct(
      <ThemeProvider theme={THEMES.light}>
        <Probe />
      </ThemeProvider>,
    );
    expect(frameOf(view)).toBe(`light:${THEMES.light.userText}`);
  });
});

describe('SettingsThemeProvider', () => {
  const render = (settings: ReturnType<typeof createMockSettingsService>, extra = {}) =>
    renderInAct(
      <SettingsThemeProvider settingsService={settings} env={{}} {...extra}>
        <Probe />
      </SettingsThemeProvider>,
    );

  it('uses an explicit ui.theme', async () => {
    const view = await render(createMockSettingsService({ 'ui.theme': 'light' }));
    expect(frameOf(view)).toContain('light:');
  });

  it('resolves auto from the terminal-reported background', async () => {
    const view = await render(createMockSettingsService({ 'ui.theme': 'auto' }), { detectedBackground: 'light' });
    expect(frameOf(view)).toContain('light:');
  });

  it('resolves auto to mono when NO_COLOR is set', async () => {
    const settings = createMockSettingsService({ 'ui.theme': 'auto' });
    const view = await renderInAct(
      <SettingsThemeProvider settingsService={settings} env={{ NO_COLOR: '1' }}>
        <Probe />
      </SettingsThemeProvider>,
    );
    expect(frameOf(view)).toBe('mono:undefined');
  });

  it('defaults to auto, which is dark when nothing is known', async () => {
    const view = await render(createMockSettingsService());
    expect(frameOf(view)).toContain('dark:');
  });

  it('switches live when ui.theme changes, without remounting', async () => {
    const settings = createMockSettingsService({ 'ui.theme': 'dark' });
    const view = await render(settings);
    expect(frameOf(view)).toContain('dark:');

    await act(async () => {
      settings.set('ui.theme', 'high-contrast', { persist: false });
    });
    expect(frameOf(view)).toContain('high-contrast:');

    await act(async () => {
      settings.set('ui.theme', 'light', { persist: false });
    });
    expect(frameOf(view)).toContain('light:');
  });
});
