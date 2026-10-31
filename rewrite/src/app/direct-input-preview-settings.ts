/** Read the same effective settings and profile labels as the source input planner. */
import type { ISettingsService } from '../../../source/services/service-interfaces.js';
import { getProfileLabel } from '../../../source/services/profiles/labels.js';
import type { ModelRef } from '../model/index.js';
import type { DirectInputPreviewConfiguration } from './direct-input-preview-types.js';

export function readDirectInputPreviewConfiguration(
  settings: Pick<ISettingsService, 'get'>,
  model: ModelRef = settings.get('agent.modelSelection'),
): DirectInputPreviewConfiguration {
  return {
    provider: model.provider,
    model: model.model,
    reasoningEffort: settings.get('agent.reasoningEffort') ?? null,
    mode: getProfileLabel(String(settings.get('app.activeProfileId'))),
  };
}
