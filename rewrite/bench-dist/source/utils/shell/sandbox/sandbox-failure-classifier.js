import { detectDeniedRead } from './denied-read-detector.js';
import { detectDockerDaemonBlock } from './docker-host-control.js';
function hasRuntimeAnnotation(rawStderr, annotatedStderr) {
    return annotatedStderr !== rawStderr;
}
function hasProxyAllowlistBlock(stderr) {
    return /blocked-by-allowlist/i.test(stderr) || (/\b403\s+Forbidden\b/i.test(stderr) && /allowlist/i.test(stderr));
}
export function classifySandboxFailure({ command, rawStderr, annotatedStderr, sandboxed, readPolicy, dockerHostControlActive, exitCode, }) {
    if (!sandboxed) {
        return null;
    }
    const runtimeAnnotated = hasRuntimeAnnotation(rawStderr, annotatedStderr);
    // Checked before the generic branches: a blocked daemon connection is
    // actionable (the user can grant host control) where "blocked" is not.
    // Reporting this replaces the command's output, so a command that succeeded
    // is taken at its word however its stderr reads.
    if (!dockerHostControlActive && exitCode !== 0 && detectDockerDaemonBlock(annotatedStderr)) {
        return {
            type: 'docker_blocked',
            confidence: runtimeAnnotated ? 'runtime_annotation' : 'stderr_pattern',
            stderr: annotatedStderr,
        };
    }
    const proxyAllowlistBlocked = hasProxyAllowlistBlock(annotatedStderr) || hasProxyAllowlistBlock(rawStderr);
    if (readPolicy === 'strict') {
        const deniedRead = detectDeniedRead(command, annotatedStderr);
        if (deniedRead) {
            return {
                type: 'denied_read',
                confidence: runtimeAnnotated ? 'runtime_annotation' : 'stderr_pattern',
                stderr: annotatedStderr,
                deniedRead,
            };
        }
    }
    if (runtimeAnnotated) {
        return {
            type: 'blocked',
            reason: proxyAllowlistBlocked ? 'network' : 'unknown',
            confidence: 'runtime_annotation',
            stderr: annotatedStderr,
        };
    }
    if (proxyAllowlistBlocked) {
        return {
            type: 'blocked',
            reason: 'network',
            confidence: 'stderr_pattern',
            stderr: annotatedStderr,
        };
    }
    return null;
}
//# sourceMappingURL=sandbox-failure-classifier.js.map