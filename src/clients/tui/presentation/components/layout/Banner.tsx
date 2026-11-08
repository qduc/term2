import React, { FC, useEffect, useRef } from 'react';
import { Box, measureElement, type DOMElement } from 'ink';
import { useTerminalColumns } from '../../hooks/use-terminal-columns.js';
import { createRequire } from 'node:module';
import { useSetting } from '../../hooks/use-setting.js';
import { getProvider } from '../../../../../model/providers/index.js';
import type { ISettingsService } from '../../../../../shared/service-interfaces.js';
import { useSkin } from '../../skins/SkinContext.js';

const require = createRequire(import.meta.url);

/**
 * Version shown beside the badge, mirroring what `cli.tsx` reports for
 * `--version`: the generated build identity when the build wrote one, and the
 * package version otherwise (source checkouts have no `dist/build-info.json`).
 * The loader is injectable so the fallback rule is testable without a build.
 */
export const resolveDisplayVersion = (load: (specifier: string) => unknown = require): string => {
  // The build (dist/src/...) and the source tree place this module at different depths.
  for (const specifier of ['../../../../../../build-info.json', '../../../../../../dist/build-info.json']) {
    try {
      const buildInfo = load(specifier) as { version?: string };
      if (buildInfo.version) return buildInfo.version;
    } catch {
      // No generated build identity in this layout.
    }
  }
  // The build emits this file below dist/, one level deeper than the source tree.
  for (const specifier of ['../../../../../../package.json', '../../../../../../../package.json']) {
    try {
      const manifest = load(specifier) as { version?: string };
      if (manifest.version) return manifest.version;
    } catch {
      // Try the next build layout.
    }
  }
  return 'unknown';
};

const version = resolveDisplayVersion();

interface BannerProps {
  settingsService: ISettingsService;
  onHeightChange?: (height: number) => void;
}

const Banner: FC<BannerProps> = ({ settingsService, onHeightChange }) => {
  const container = useRef<DOMElement>(null);
  // Ink recomputes Yoga on resize without rerendering React. The width hook makes
  // the measurement run again after a wrap or a skin's responsive layout changes.
  useTerminalColumns();
  useEffect(() => {
    if (container.current && onHeightChange) onHeightChange(measureElement(container.current).height);
  });
  const { Banner: SkinBanner } = useSkin();
  const selection = useSetting(settingsService, 'agent.modelSelection');
  const model = selection.model;
  const providerKey = selection.provider;
  const reasoningEffort = useSetting(settingsService, 'agent.reasoningEffort') ?? 'default';

  const providerDef = getProvider(providerKey);
  const providerLabel = providerDef?.label || providerKey;
  const banner = (
    <SkinBanner version={version} providerLabel={providerLabel} model={model} reasoningEffort={reasoningEffort} />
  );
  return onHeightChange ? (
    <Box ref={container} flexDirection="column">
      {banner}
    </Box>
  ) : (
    banner
  );
};

export default Banner;
