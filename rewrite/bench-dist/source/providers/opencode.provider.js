const OPENCODE_HOST_FRAGMENT = 'opencode.ai';
export function isOpencodeProvider(identity) {
    return (identity.type === 'opencode' ||
        identity.name === 'opencode' ||
        (typeof identity.baseUrl === 'string' && identity.baseUrl.toLowerCase().includes(OPENCODE_HOST_FRAGMENT)));
}
export function resolveOpencodeRuntimeConfig(baseUrl, apiKey) {
    return {
        baseUrl: baseUrl ?? 'https://opencode.ai/v1',
        apiKey: apiKey ?? process.env.OPENCODE_API_KEY,
    };
}
/** OpenCode can send a marker-only trailer after the terminal chat chunk. */
export function isOpencodeTrailer(chunk) {
    return typeof chunk['x-opencode-type'] === 'string';
}
//# sourceMappingURL=opencode.provider.js.map