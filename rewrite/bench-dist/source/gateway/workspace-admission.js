import { createHash } from 'node:crypto';
import { realpathSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export class WorkspaceAdmissionError extends Error {
    code;
    constructor(code) {
        super('workspace admission rejected');
        this.name = 'WorkspaceAdmissionError';
        this.code = code;
    }
}
export function validateGatewayManifest(value) {
    if (!value || typeof value !== 'object')
        throw new WorkspaceAdmissionError('manifest_invalid');
    const candidate = value;
    if (!Number.isInteger(candidate.version) || candidate.version < 1 || !Array.isArray(candidate.grants)) {
        throw new WorkspaceAdmissionError('manifest_invalid');
    }
    const ids = new Set();
    const grants = candidate.grants.map((grant) => validateGrant(grant, ids));
    if (candidate.sha256 !== undefined &&
        (typeof candidate.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(candidate.sha256))) {
        throw new WorkspaceAdmissionError('manifest_invalid');
    }
    return {
        version: candidate.version,
        grants,
        sshTargets: validateSshTargets(candidate.sshTargets),
        sha256: typeof candidate.sha256 === 'string' ? candidate.sha256 : undefined,
    };
}
export function loadGatewayManifest(filename, expectedSha256) {
    try {
        const raw = readFileSync(filename, 'utf8');
        if (expectedSha256 && createHash('sha256').update(raw).digest('hex') !== expectedSha256.toLowerCase()) {
            throw new WorkspaceAdmissionError('manifest_invalid');
        }
        return validateGatewayManifest(JSON.parse(raw));
    }
    catch (error) {
        if (error instanceof WorkspaceAdmissionError)
            throw error;
        throw new WorkspaceAdmissionError('manifest_invalid');
    }
}
function validateGrant(value, ids) {
    if (!value || typeof value !== 'object')
        throw new WorkspaceAdmissionError('manifest_invalid');
    const grant = value;
    if (typeof grant.workspaceId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,256}$/.test(grant.workspaceId) ||
        ids.has(grant.workspaceId) ||
        typeof grant.ownerUserId !== 'string' ||
        !grant.ownerUserId ||
        typeof grant.label !== 'string' ||
        !isProvisionedLabel(grant.label) ||
        (grant.kind !== 'local' && grant.kind !== 'ssh') ||
        (grant.access !== 'read' && grant.access !== 'read_write') ||
        typeof grant.enabled !== 'boolean')
        throw new WorkspaceAdmissionError('manifest_invalid');
    ids.add(grant.workspaceId);
    if (grant.kind === 'local' && (typeof grant.localRoot !== 'string' || !path.isAbsolute(grant.localRoot)))
        throw new WorkspaceAdmissionError('manifest_invalid');
    if (grant.kind === 'ssh' && typeof grant.sshTargetId !== 'string')
        throw new WorkspaceAdmissionError('manifest_invalid');
    return {
        workspaceId: grant.workspaceId,
        ownerUserId: grant.ownerUserId,
        label: grant.label,
        kind: grant.kind,
        localRoot: typeof grant.localRoot === 'string' ? grant.localRoot : undefined,
        sshTargetId: typeof grant.sshTargetId === 'string' ? grant.sshTargetId : undefined,
        remoteRoot: typeof grant.remoteRoot === 'string' ? grant.remoteRoot : undefined,
        access: grant.access,
        enabled: grant.enabled,
    };
}
function validateSshTargets(value) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value))
        throw new WorkspaceAdmissionError('manifest_invalid');
    return value.map((item) => {
        if (!item || typeof item !== 'object')
            throw new WorkspaceAdmissionError('manifest_invalid');
        const target = item;
        if (typeof target.sshTargetId !== 'string' ||
            typeof target.host !== 'string' ||
            !Number.isInteger(target.port) ||
            typeof target.username !== 'string' ||
            !Array.isArray(target.remoteRootAllowlist) ||
            typeof target.knownHostsProfile !== 'string' ||
            typeof target.agentProfileId !== 'string' ||
            typeof target.enabled !== 'boolean')
            throw new WorkspaceAdmissionError('manifest_invalid');
        return {
            sshTargetId: target.sshTargetId,
            host: target.host,
            port: target.port,
            username: target.username,
            remoteRootAllowlist: target.remoteRootAllowlist.filter((root) => typeof root === 'string'),
            knownHostsProfile: target.knownHostsProfile,
            agentProfileId: target.agentProfileId,
            enabled: target.enabled,
        };
    });
}
export class WorkspaceAdmission {
    /** Live (runtime-backed) session bindings; the one-per-workspace constraint applies here. */
    #sessions = new Map();
    /** Restored bindings from the persisted index (read-only history, no runtime). */
    #restored = new Map();
    #dynamicGrants = new Map();
    #dynamicRevision = 0;
    #manifest;
    #allowSsh;
    #allowWrite;
    #boundaryProbe;
    #onDynamicGrantChange;
    constructor(manifest, options = {}) {
        const resolved = typeof options === 'boolean' ? { allowSsh: options } : options;
        this.#allowSsh = resolved.allowSsh === true;
        this.#allowWrite = resolved.allowWrite === true;
        this.#boundaryProbe = resolved.boundaryProbe;
        this.#onDynamicGrantChange = resolved.onDynamicGrantChange;
        this.#manifest = validateGatewayManifest(manifest);
        for (const grant of resolved.initialDynamicGrants ?? []) {
            // Each dynamic grant represents one prior register(), which bumped the
            // revision; restoring them reproduces the manifestVersion the sessions
            // recorded as grantVersion.
            if (!validateDynamicGrant(grant) ||
                this.#dynamicGrants.has(grant.workspaceId) ||
                this.#manifest.grants.some((candidate) => candidate.workspaceId === grant.workspaceId)) {
                throw new WorkspaceAdmissionError('manifest_invalid');
            }
            this.#dynamicGrants.set(grant.workspaceId, Object.freeze({ ...grant }));
            this.#dynamicRevision += 1;
        }
    }
    get manifestVersion() {
        return this.#manifest.version + this.#dynamicRevision;
    }
    replaceManifest(manifest) {
        this.#manifest = validateGatewayManifest(manifest);
        this.#dynamicGrants.clear();
        this.#dynamicRevision = 0;
    }
    listAliases(ownerUserId) {
        return [...this.#manifest.grants, ...this.#dynamicGrants.values()]
            .filter((grant) => grant.enabled && grant.kind === 'local' && grant.ownerUserId === ownerUserId)
            .map(({ workspaceId, access, label }) => ({ workspaceId, access, label }));
    }
    /** Add a server-validated local root without weakening manifest admission. */
    registerDynamicLocalGrant(grant) {
        if (grant.kind !== 'local' ||
            !grant.localRoot ||
            !path.isAbsolute(grant.localRoot) ||
            !grant.ownerUserId ||
            !isProvisionedLabel(grant.label) ||
            !/^[A-Za-z0-9_-]{1,256}$/.test(grant.workspaceId) ||
            (grant.access !== 'read' && grant.access !== 'read_write') ||
            grant.enabled !== true ||
            [...this.#manifest.grants, ...this.#dynamicGrants.values()].some((candidate) => candidate.workspaceId === grant.workspaceId)) {
            throw new WorkspaceAdmissionError('manifest_invalid');
        }
        this.#dynamicGrants.set(grant.workspaceId, Object.freeze({ ...grant }));
        this.#dynamicRevision += 1;
        this.#persistDynamicGrants();
        return this.manifestVersion;
    }
    removeDynamicLocalGrant(workspaceId) {
        if (this.#dynamicGrants.delete(workspaceId)) {
            this.#dynamicRevision -= 1;
            this.#persistDynamicGrants();
        }
    }
    #persistDynamicGrants() {
        this.#onDynamicGrantChange?.([...this.#dynamicGrants.values()]);
    }
    admit(claims, requestedManifestVersion = this.manifestVersion) {
        const binding = this.prepare(claims, requestedManifestVersion);
        if ([...this.#sessions.values()].some((session) => session.workspaceId === binding.workspaceId)) {
            throw new WorkspaceAdmissionError('workspace_session_exists');
        }
        this.#sessions.set(binding.sessionId, binding);
        return binding;
    }
    /** Validate and construct a binding without reserving an active session. */
    prepare(claims, requestedManifestVersion = this.manifestVersion) {
        if (claims.purpose !== 'session_create')
            throw new WorkspaceAdmissionError('workspace_not_found');
        if (requestedManifestVersion !== this.manifestVersion)
            throw new WorkspaceAdmissionError('manifest_version_mismatch');
        const workspaceId = claims.workspaceId;
        if (!workspaceId)
            throw new WorkspaceAdmissionError('workspace_not_found');
        const grant = this.#grantFor(workspaceId);
        if (!grant)
            throw new WorkspaceAdmissionError('workspace_not_found');
        if (grant.ownerUserId !== claims.sub)
            throw new WorkspaceAdmissionError('workspace_owner_mismatch');
        if (!grant.enabled)
            throw new WorkspaceAdmissionError('workspace_disabled');
        if (grant.kind === 'ssh') {
            if (!this.#allowSsh)
                throw new WorkspaceAdmissionError('ssh_disabled');
            throw new WorkspaceAdmissionError('ssh_disabled');
        }
        const canonicalRoot = canonicalizeGrantRoot(grant);
        const boundary = this.#boundaryProbe?.(canonicalRoot, grant.access);
        if (!boundary || boundary.mountedRoot !== canonicalRoot) {
            throw new WorkspaceAdmissionError('workspace_boundary_unverified');
        }
        if (grant.access === 'read_write' && (!this.#allowWrite || !boundary.writable)) {
            throw new WorkspaceAdmissionError('write_not_allowed');
        }
        if (grant.access === 'read' && boundary.writable) {
            throw new WorkspaceAdmissionError('workspace_boundary_unverified');
        }
        const binding = {
            sessionId: randomUUID(),
            ownerUserId: claims.sub,
            workspaceId: grant.workspaceId,
            grantVersion: this.manifestVersion,
            canonicalRoot,
            access: grant.access,
        };
        return Object.freeze(binding);
    }
    /**
     * Reconstruct an immutable binding from the gateway-owned session index after
     * a daemon restart. The index supplies only opaque identity/version fields;
     * the manifest and boundary probe remain the authority for the root.
     */
    restore(sessionId, ownerUserId, workspaceId, grantVersion) {
        const current = this.#sessions.get(sessionId) ?? this.#restored.get(sessionId);
        if (current) {
            if (current.ownerUserId !== ownerUserId || current.workspaceId !== workspaceId)
                throw new WorkspaceAdmissionError('session_owner_mismatch');
            if (current.grantVersion !== grantVersion)
                throw new WorkspaceAdmissionError('manifest_version_mismatch');
            return current;
        }
        if (grantVersion > this.manifestVersion || grantVersion < this.#manifest.version)
            throw new WorkspaceAdmissionError('manifest_version_mismatch');
        const grant = this.#grantFor(workspaceId);
        if (!grant)
            throw new WorkspaceAdmissionError('workspace_not_found');
        if (grant.ownerUserId !== ownerUserId)
            throw new WorkspaceAdmissionError('workspace_owner_mismatch');
        if (!grant.enabled)
            throw new WorkspaceAdmissionError('workspace_disabled');
        if (grant.kind === 'ssh' || !grant.localRoot)
            throw new WorkspaceAdmissionError('ssh_disabled');
        const canonicalRoot = canonicalizeGrantRoot(grant);
        const boundary = this.#boundaryProbe?.(canonicalRoot, grant.access);
        if (!boundary || boundary.mountedRoot !== canonicalRoot)
            throw new WorkspaceAdmissionError('workspace_boundary_unverified');
        if (grant.access === 'read_write' && (!this.#allowWrite || !boundary.writable))
            throw new WorkspaceAdmissionError('write_not_allowed');
        if (grant.access === 'read' && boundary.writable)
            throw new WorkspaceAdmissionError('workspace_boundary_unverified');
        const binding = {
            sessionId,
            ownerUserId,
            workspaceId: grant.workspaceId,
            grantVersion,
            canonicalRoot,
            access: grant.access,
        };
        this.#restored.set(sessionId, binding);
        return Object.freeze(binding);
    }
    getSession(sessionId, ownerUserId) {
        const session = this.#sessions.get(sessionId) ?? this.#restored.get(sessionId);
        if (!session)
            throw new WorkspaceAdmissionError('session_not_found');
        if (session.ownerUserId !== ownerUserId)
            throw new WorkspaceAdmissionError('session_owner_mismatch');
        return session;
    }
    assertSessionWorkspace(sessionId, ownerUserId, workspaceId) {
        const session = this.getSession(sessionId, ownerUserId);
        if (session.workspaceId !== workspaceId)
            throw new WorkspaceAdmissionError('session_owner_mismatch');
        return session;
    }
    retarget() {
        throw new WorkspaceAdmissionError('session_retarget_forbidden');
    }
    remove(sessionId) {
        this.#sessions.delete(sessionId);
        this.#restored.delete(sessionId);
    }
    #grantFor(workspaceId) {
        return (this.#dynamicGrants.get(workspaceId) ??
            this.#manifest.grants.find((candidate) => candidate.workspaceId === workspaceId));
    }
    static assertPath(binding, requestedPath) {
        if (!requestedPath || requestedPath.includes('\u0000') || path.isAbsolute(requestedPath)) {
            throw new WorkspaceAdmissionError('workspace_path_escape');
        }
        const parts = requestedPath.split(/[\\/]+/);
        if (parts.includes('..'))
            throw new WorkspaceAdmissionError('workspace_path_escape');
        const candidate = path.resolve(binding.canonicalRoot, requestedPath);
        let resolved;
        try {
            resolved = realpathSync(candidate);
        }
        catch {
            throw new WorkspaceAdmissionError('workspace_path_escape');
        }
        if (!isContained(binding.canonicalRoot, resolved))
            throw new WorkspaceAdmissionError('workspace_path_escape');
        return resolved;
    }
}
export function validateDynamicGrant(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const grant = value;
    return (typeof grant.workspaceId === 'string' &&
        /^[A-Za-z0-9_-]{1,256}$/.test(grant.workspaceId) &&
        typeof grant.ownerUserId === 'string' &&
        grant.ownerUserId.length > 0 &&
        isProvisionedLabel(grant.label) &&
        grant.kind === 'local' &&
        typeof grant.localRoot === 'string' &&
        path.isAbsolute(grant.localRoot) &&
        (grant.access === 'read' || grant.access === 'read_write') &&
        grant.enabled === true);
}
function canonicalizeGrantRoot(grant) {
    if (!grant.localRoot)
        throw new WorkspaceAdmissionError('workspace_root_unavailable');
    let actual;
    try {
        actual = realpathSync(grant.localRoot);
        if (!statSync(actual).isDirectory())
            throw new Error();
    }
    catch {
        throw new WorkspaceAdmissionError('workspace_root_unavailable');
    }
    if (actual !== path.resolve(grant.localRoot))
        throw new WorkspaceAdmissionError('workspace_root_not_canonical');
    return actual;
}
function isContained(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function isProvisionedLabel(value) {
    return value.length > 0 && value.length <= 120 && value === value.trim() && !/[\u0000\r\n]/.test(value);
}
//# sourceMappingURL=workspace-admission.js.map