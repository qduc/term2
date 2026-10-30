function parseGptVersion(value) {
    const trimmed = value.trim();
    const match = trimmed.match(/^gpt-(\d+)(?:\.(\d+))?/i);
    if (!match) {
        return null;
    }
    // Reject ambiguous exact-match multi-digit versions like 'gpt-50'.
    // A valid GPT version prefix should either have a minor version or a suffix.
    const afterMatch = trimmed.slice(match[0].length);
    if (!afterMatch && match[1].length > 1 && !match[2]) {
        return null;
    }
    return {
        major: Number(match[1]),
        minor: Number(match[2] ?? '0'),
    };
}
function isGptVersionAtLeast(model, minimum) {
    const modelVersion = parseGptVersion(model);
    const minimumVersion = parseGptVersion(minimum);
    if (!modelVersion || !minimumVersion) {
        return false;
    }
    if (modelVersion.major !== minimumVersion.major) {
        return modelVersion.major > minimumVersion.major;
    }
    return modelVersion.minor >= minimumVersion.minor;
}
function matchesNativePatchPrefix(model, prefix) {
    const normalizedModel = model.trim();
    const normalizedPrefix = prefix.trim();
    if (!normalizedModel || !normalizedPrefix) {
        return false;
    }
    const modelVersion = parseGptVersion(normalizedModel);
    const prefixVersion = parseGptVersion(normalizedPrefix);
    if (modelVersion && prefixVersion) {
        return isGptVersionAtLeast(normalizedModel, normalizedPrefix);
    }
    return normalizedModel.startsWith(normalizedPrefix);
}
/** Model families that use the modern patch-first tool surface. */
export function isGpt5OrGpt6Model(model) {
    const normalized = model.toLowerCase();
    return normalized.includes('gpt-5') || normalized.includes('gpt-6');
}
export function shouldPreferPatchEditingModel(model) {
    return isGpt5OrGpt6Model(model);
}
export function shouldUseNativePatchTool({ providerId, model, capabilities, }) {
    const modelPrefixes = capabilities?.nativePatchModelPrefixes;
    if (modelPrefixes && modelPrefixes.length > 0) {
        return modelPrefixes.some((prefix) => matchesNativePatchPrefix(model, prefix));
    }
    return providerId === 'openai' && isGptVersionAtLeast(model, 'gpt-5.1');
}
export function shouldUseStrictToolSchema({ providerId, capabilities, }) {
    if (capabilities?.usesStrictToolSchema !== undefined) {
        return capabilities.usesStrictToolSchema;
    }
    return providerId === 'openai';
}
//# sourceMappingURL=tool-selection-policy.js.map