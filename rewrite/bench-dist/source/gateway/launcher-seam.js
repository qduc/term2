import { getProfileLabel } from '../services/profiles/labels.js';
/**
 * Capture the settings that belong to one server session.  This deliberately
 * reads only non-secret settings; credentials remain owned by the launcher
 * process and are never copied into the worker boundary or a browser DTO.
 */
export function createSessionSettingsSnapshot(input) {
    const settings = input.settings;
    const mode = input.mode ?? getProfileLabel(String(settings.get('app.activeProfileId')));
    const policy = Object.freeze({
        allowWrite: false,
        autoApprove: false,
        allowUnsandboxed: false,
        sshEnabled: false,
        ...(input.effectiveToolPolicy ?? {}),
    });
    return Object.freeze({
        providerId: input.providerId ?? settings.get('agent.modelSelection').provider,
        modelId: input.modelId ?? settings.get('agent.modelSelection').model,
        reasoningEffort: input.reasoningEffort ?? String(settings.get('agent.reasoningEffort') ?? 'default'),
        mode,
        effectiveToolPolicy: policy,
        ...(input.defaultsRevision === undefined ? {} : { defaultsRevision: input.defaultsRevision }),
    });
}
//# sourceMappingURL=launcher-seam.js.map