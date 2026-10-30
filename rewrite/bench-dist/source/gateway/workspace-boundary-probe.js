import { accessSync, constants, realpathSync, statSync } from 'node:fs';
const defaultFs = { realpathSync, statSync, accessSync };
/**
 * Proves a local workspace using the canonical path and the OS user's access
 * checks. The launcher policy is deliberately part of the probe: a writable
 * filesystem is not a writable gateway grant when --allow-write is absent.
 * For a `read` grant the probe reports `writable: false` by construction,
 * whatever the OS user could do to the folder. For a `read_write` grant it
 * still requires both `--allow-write` and physical write access to the folder.
 * Keeping a `read` session's tools read-only is the runtime's job, not the
 * probe's.
 */
export function createRealWorkspaceBoundaryProbe(options) {
    const fs = options.fs ?? defaultFs;
    return (canonicalRoot, access) => {
        try {
            const actual = fs.realpathSync(canonicalRoot);
            if (actual !== canonicalRoot || !fs.statSync(actual).isDirectory())
                return false;
            fs.accessSync(actual, constants.R_OK | constants.X_OK);
            const physicallyWritable = canWrite(fs, actual);
            return {
                mountedRoot: actual,
                writable: access === 'read_write' && options.allowWrite && physicallyWritable,
                ...(access === 'read_write' && !options.allowWrite ? { policy: 'read_only_launcher' } : {}),
            };
        }
        catch {
            return false;
        }
    };
}
function canWrite(fs, root) {
    try {
        fs.accessSync(root, constants.W_OK);
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=workspace-boundary-probe.js.map