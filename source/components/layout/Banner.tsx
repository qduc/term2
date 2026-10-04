import { toTierModelPoolEntries } from '../../services/agent-runtime/model-resolver.js';
import React, { FC } from 'react';
import { createRequire } from 'node:module';
import { useSetting } from '../../hooks/use-setting.js';
import { getProvider } from '../../providers/index.js';
import type { SettingsService } from '../../services/settings/settings-service.js';
import type { ModeBadge } from '../theme.js';
import { useSkin } from '../../skins/SkinContext.js';

const require = createRequire(import.meta.url);

/**
 * Version shown beside the badge, mirroring what `cli.tsx` reports for
 * `--version`: the generated build identity when the build wrote one, and the
 * package version otherwise (source checkouts have no `dist/build-info.json`).
 * The loader is injectable so the fallback rule is testable without a build.
 */
export const resolveDisplayVersion = (load: (specifier: string) => unknown = require): string => {
  try {
    const buildInfo = load('../../../dist/build-info.json') as { version?: string };
    if (buildInfo.version) {
      return buildInfo.version;
    }
  } catch {
    // No generated build identity on disk.
  }
  return (load('../../../package.json') as { version: string }).version;
};

const version = resolveDisplayVersion();

interface BannerProps {
  settingsService: SettingsService;
}

const PROFILE_BASE_BADGES: Record<string, ModeBadge> = {
  'builtin:standard': 'STANDARD',
  'builtin:lite': 'LITE',
  'builtin:plan': 'PLAN',
  'builtin:mentor': 'STANDARD',
  'builtin:orchestrator': 'ORCHESTRATOR',
};

const Banner: FC<BannerProps> = ({ settingsService }) => {
  const { Banner: SkinBanner } = useSkin();
  const activeProfileId = useSetting(settingsService, 'app.activeProfileId') ?? 'builtin:standard';
  const selection = useSetting(settingsService, 'agent.modelSelection');
  const model = selection.model;
  const smartPool = useSetting(settingsService, 'agent.smartModel');
  // Display uses the pool's first entry; the pool cursor only advances per
  // subagent spawn.
  const smartModel = toTierModelPoolEntries(smartPool)[0]?.model;
  const mentorModel = smartModel;
  const providerKey = selection.provider;
  const reasoningEffort = useSetting(settingsService, 'agent.reasoningEffort') ?? 'default';
  const mentorReasoningEffort = useSetting(settingsService, 'agent.mentorReasoningEffort') ?? 'default';

  const providerDef = getProvider(providerKey);
  const providerLabel = providerDef?.label || providerKey;

  return (
    <SkinBanner
      version={version}
      mode={PROFILE_BASE_BADGES[String(activeProfileId)] ?? 'STANDARD'}
      mentor={activeProfileId === 'builtin:mentor'}
      providerLabel={providerLabel}
      model={model}
      reasoningEffort={reasoningEffort}
      mentorModel={mentorModel}
      mentorReasoningEffort={mentorReasoningEffort}
    />
  );
};

export default Banner;
