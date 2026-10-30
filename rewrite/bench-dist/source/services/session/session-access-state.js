import fs from 'node:fs';
import { getActiveWorkspaceRoot } from '../workspace/active-workspace-root.js';
import path from 'node:path';
import { requestsDockerHostControl } from '../../utils/shell/sandbox/docker-host-control.js';
/** Session-bound read and Docker state; project Docker grants stay in settings. */
export class SessionAccessState {
    settings;
    options;
    #readFolders = new Set();
    #editFiles = new Set();
    #editFolders = new Set();
    #createdFiles = new Set();
    #dockerOnce = new Set();
    #dockerRoots = new Set();
    #dockerDenials = new Set();
    constructor(settings, options = {}) {
        this.settings = settings;
        this.options = options;
    }
    get isReadOnly() {
        return this.options.allowEdit === false;
    }
    recordCreatedFile(file, baseDir = getActiveWorkspaceRoot()) {
        this.#createdFiles.add(path.resolve(baseDir, file));
    }
    isCreatedInSession(targetPath, baseDir = getActiveWorkspaceRoot()) {
        const target = path.resolve(baseDir, targetPath);
        return this.#createdFiles.has(target);
    }
    removeCreatedFile(file, baseDir = getActiveWorkspaceRoot()) {
        this.#createdFiles.delete(path.resolve(baseDir, file));
    }
    allowReadFolder(folder) {
        this.#readFolders.add(folder);
    }
    allowsRead(targetPath, baseDir = getActiveWorkspaceRoot()) {
        const target = path.resolve(baseDir, targetPath);
        return [...this.#readFolders].some((folder) => {
            const resolvedFolder = path.resolve(baseDir, folder);
            return target === resolvedFolder || target.startsWith(`${resolvedFolder}${path.sep}`);
        });
    }
    allowEditFile(file, baseDir = getActiveWorkspaceRoot()) {
        this.#editFiles.add(path.resolve(baseDir, file));
    }
    allowEditFolder(folder, baseDir = getActiveWorkspaceRoot()) {
        this.#editFolders.add(path.resolve(baseDir, folder));
    }
    allowsEdit(targetPath, baseDir = getActiveWorkspaceRoot()) {
        if (this.options.allowEdit === false)
            return false;
        const target = path.resolve(baseDir, targetPath);
        return (this.#editFiles.has(target) ||
            [...this.#editFolders].some((folder) => target === folder || target.startsWith(`${folder}${path.sep}`)));
    }
    requiresDockerApproval(command) {
        return requestsDockerHostControl(command) || this.#dockerDenials.has(command);
    }
    grantDocker(command, cwd, scope) {
        if (scope === 'once')
            this.#dockerOnce.add(command);
        if (scope === 'session')
            this.#dockerRoots.add(realRoot(cwd));
        if (scope === 'project')
            this.#grantDockerProject(cwd);
    }
    hasDockerGrant(command, cwd) {
        return this.hasDockerProject(cwd) || this.#dockerRoots.has(realRoot(cwd)) || this.#dockerOnce.delete(command);
    }
    hasDockerSessionGrant(cwd) {
        return this.#dockerRoots.has(realRoot(cwd));
    }
    hasDockerProject(cwd) {
        return (this.settings.get('sandbox.dockerHostControlProjects') ?? []).includes(realRoot(cwd));
    }
    recordDockerDenial(command) {
        this.#dockerDenials.add(command);
    }
    consumeDockerDenial(command) {
        return this.#dockerDenials.delete(command);
    }
    /** Clears state that must not survive a reset or imported conversation. */
    clearTransient() {
        this.#readFolders.clear();
        this.#editFiles.clear();
        this.#editFolders.clear();
        this.#createdFiles.clear();
        this.#dockerOnce.clear();
        this.#dockerRoots.clear();
        this.#dockerDenials.clear();
    }
    dispose() {
        this.clearTransient();
    }
    #grantDockerProject(cwd) {
        const root = realRoot(cwd);
        const projects = this.settings.get('sandbox.dockerHostControlProjects') ?? [];
        if (!projects.includes(root))
            this.settings.set('sandbox.dockerHostControlProjects', [...projects, root]);
    }
}
const realRoot = (cwd) => {
    const resolved = path.resolve(cwd);
    try {
        return fs.realpathSync(resolved);
    }
    catch {
        return resolved;
    }
};
//# sourceMappingURL=session-access-state.js.map