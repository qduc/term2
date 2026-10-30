/**
 * Simple SSH config file parser
 * Parses ~/.ssh/config format to resolve host aliases
 */
/**
 * Parse SSH config content into a map of host aliases to their configurations
 */
export function parseSSHConfig(content) {
    const result = {};
    let currentHost = null;
    const lines = content.split('\n');
    for (const rawLine of lines) {
        const line = rawLine.trim();
        // Skip empty lines and comments
        if (!line || line.startsWith('#')) {
            continue;
        }
        // Parse key-value pairs (supports both "Key Value" and "Key=Value" formats)
        let key;
        let value;
        const equalsIndex = line.indexOf('=');
        const spaceIndex = line.search(/\s/);
        if (equalsIndex !== -1 && (spaceIndex === -1 || equalsIndex < spaceIndex)) {
            // Key=Value format
            key = line.substring(0, equalsIndex).trim();
            value = line.substring(equalsIndex + 1).trim();
        }
        else if (spaceIndex !== -1) {
            // Key Value format
            key = line.substring(0, spaceIndex).trim();
            value = line.substring(spaceIndex + 1).trim();
        }
        else {
            // Skip malformed lines
            continue;
        }
        const keyLower = key.toLowerCase();
        if (keyLower === 'host') {
            currentHost = value;
            if (!result[currentHost]) {
                result[currentHost] = {};
            }
        }
        else if (currentHost) {
            const hostConfig = result[currentHost];
            switch (keyLower) {
                case 'hostname':
                    hostConfig.hostName = value;
                    break;
                case 'user':
                    hostConfig.user = value;
                    break;
                case 'port':
                    hostConfig.port = parseInt(value, 10);
                    break;
                case 'identityfile':
                    hostConfig.identityFile = value;
                    break;
                // Ignore other options for now
            }
        }
    }
    return result;
}
/**
 * Resolve SSH host configuration, merging with wildcard defaults
 * Returns undefined if the host is not found in the config
 */
export function resolveSSHHost(host, configContent) {
    const configMap = parseSSHConfig(configContent);
    const hostConfig = configMap[host];
    const wildcardConfig = configMap['*'];
    // If host not found and no wildcard, return undefined
    if (!hostConfig && !wildcardConfig) {
        return undefined;
    }
    // If only wildcard exists but no specific host, return undefined
    // (we need an explicit host entry to resolve an alias)
    if (!hostConfig) {
        return undefined;
    }
    // Merge wildcard defaults with host-specific config
    // Host-specific values take precedence
    return {
        ...wildcardConfig,
        ...hostConfig,
    };
}
//# sourceMappingURL=ssh-config-parser.js.map