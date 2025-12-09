import path from 'path';
import {loggingService} from '../../services/logging-service.js';
import {
    SafetyStatus,
    SYSTEM_PATHS,
    SENSITIVE_EXTENSIONS,
    HOME_PATTERNS,
    SENSITIVE_PATHS,
    SAFE_JSON_FILES,
    SUSPICIOUS_JSON_PATTERNS,
} from './constants.js';

export function analyzePathRisk(inputPath: string | undefined): SafetyStatus {
    const candidate = inputPath?.trim();
    if (!candidate) return SafetyStatus.GREEN;

    // RED: Home directory and sensitive paths
    // Check for various home directory representations
    const isHomeRelated = HOME_PATTERNS.some(pattern =>
        pattern.test(candidate),
    );

    if (isHomeRelated) {
        // Extract the path after home prefix for further analysis
        const sliced = candidate
            .replace(/^~/, '')
            .replace(/^\$\{?HOME\}?/, '')
            .replace(/^\$\{?USER\}?/, '')
            .replace(/^\$\{?LOGNAME\}?/, '')
            .replace(/^\/home\/[^/]+/, '')
            .replace(/^\/Users\/[^/]+/, '')
            .replace(/^\/root/, '');

        // Plain home directory access without any suffix is RED
        if (sliced === '' || sliced === '/') {
            loggingService.security('Path risk: home directory access', {
                path: candidate,
            });
            return SafetyStatus.RED;
        }

        // Check for sensitive dotfiles and directories
        if (
            /^\/\.\w+/.test(sliced) ||
            SENSITIVE_PATHS.some(sensitive => sliced.includes(sensitive))
        ) {
            loggingService.security('Path risk: home dotfile or config', {
                path: candidate,
            });
            return SafetyStatus.RED;
        }

        // Check if filename in home directory is suspicious (credentials, secrets, etc.)
        const filename = path.basename(candidate);
        if (
            /\.json$/i.test(filename) &&
            SUSPICIOUS_JSON_PATTERNS.some(pattern => pattern.test(filename))
        ) {
            loggingService.security(
                'Path risk: suspicious JSON file in home directory',
                {path: candidate},
            );
            return SafetyStatus.RED;
        }

        // Check for other sensitive extensions in home directory
        if (SENSITIVE_EXTENSIONS.some(ext => filename.endsWith(ext))) {
            loggingService.security(
                'Path risk: sensitive file in home directory',
                {path: candidate},
            );
            return SafetyStatus.RED;
        }
    }

    // RED: Absolute System Paths
    if (path.isAbsolute(candidate)) {
        if (SYSTEM_PATHS.some(sys => candidate.startsWith(sys))) {
            loggingService.security('Path risk: absolute system path', {
                path: candidate,
            });
            return SafetyStatus.RED;
        }
        // Home dotfiles when absolute
        if (
            /^\/(home|Users)\/[^/]+\/\.\w+/.test(candidate) ||
            candidate.includes('/.ssh') ||
            candidate.includes('/.gitconfig')
        ) {
            loggingService.security('Path risk: absolute home dotfile', {
                path: candidate,
            });
            return SafetyStatus.RED;
        }
        // Other absolute paths are suspicious -> audit
        loggingService.security('Path risk: absolute non-system path', {
            path: candidate,
        });
        return SafetyStatus.YELLOW;
    }

    // RED: Directory Traversal
    if (candidate.includes('..')) {
        loggingService.security('Path risk: directory traversal detected', {
            path: candidate,
        });
        return SafetyStatus.RED;
    }

    const filename = path.basename(candidate);

    // JSON files: check allowlist and suspicious patterns BEFORE hidden file check
    // This ensures safe JSON files like .eslintrc.json are GREEN
    // Use case-insensitive check for .json extension
    if (/\.json$/i.test(filename)) {
        // Safe project config files are always GREEN
        // Check case-insensitively by converting to lowercase
        if (SAFE_JSON_FILES.has(filename.toLowerCase())) {
            return SafetyStatus.GREEN;
        }

        // Check for suspicious credential/token patterns
        if (SUSPICIOUS_JSON_PATTERNS.some(pattern => pattern.test(filename))) {
            loggingService.security('Path risk: suspicious JSON filename', {
                path: candidate,
            });
            return SafetyStatus.YELLOW;
        }

        // Other JSON files are GREEN by default (permissive)
        return SafetyStatus.GREEN;
    }

    // Hidden files -> YELLOW
    if (filename.startsWith('.')) {
        loggingService.security('Path risk: hidden file', {path: candidate});
        return SafetyStatus.YELLOW;
    }

    // Sensitive extensions
    if (SENSITIVE_EXTENSIONS.some(ext => filename.endsWith(ext))) {
        loggingService.security('Path risk: sensitive extension', {
            path: candidate,
        });
        return SafetyStatus.YELLOW;
    }

    return SafetyStatus.GREEN;
}