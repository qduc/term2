const BRANCH_PREFIX = 'refs/heads/';
/**
 * Parses `git worktree list --porcelain`. Records are separated by blank lines;
 * each attribute is either a bare keyword (`detached`, `bare`) or a keyword
 * followed by a value, where `locked` and `prunable` may carry a trailing reason
 * we deliberately discard.
 */
export function parseWorktreeList(output) {
    const worktrees = [];
    let current;
    const commit = () => {
        if (current) {
            worktrees.push(current);
            current = undefined;
        }
    };
    for (const rawLine of output.split('\n')) {
        const line = rawLine.trimEnd();
        if (line === '') {
            commit();
            continue;
        }
        const separator = line.indexOf(' ');
        const keyword = separator === -1 ? line : line.slice(0, separator);
        const value = separator === -1 ? '' : line.slice(separator + 1);
        if (keyword === 'worktree') {
            commit();
            current = { path: value, detached: false, bare: false, locked: false, prunable: false };
            continue;
        }
        if (!current)
            continue;
        switch (keyword) {
            case 'HEAD':
                current.head = value;
                break;
            case 'branch':
                current.branch = value.startsWith(BRANCH_PREFIX) ? value.slice(BRANCH_PREFIX.length) : value;
                break;
            case 'detached':
                current.detached = true;
                break;
            case 'bare':
                current.bare = true;
                break;
            case 'locked':
                current.locked = true;
                break;
            case 'prunable':
                current.prunable = true;
                break;
            default:
                break;
        }
    }
    commit();
    return worktrees;
}
//# sourceMappingURL=parse-worktree-list.js.map