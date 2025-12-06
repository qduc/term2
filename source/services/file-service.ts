import path from 'node:path';
import {promises as fs} from 'node:fs';
import fg from 'fast-glob';
import {default as createIgnore, type Ignore} from 'ignore';
import type {Entry} from 'fast-glob';
import {loggingService} from './logging-service.js';

export type PathEntry = {
	path: string;
	type: 'file' | 'directory';
};

const workspaceRoot = process.cwd();
const DEFAULT_IGNORES = ['.git/**'];
const GITIGNORE_PATH = path.join(workspaceRoot, '.gitignore');
const MAX_SCAN_DEPTH = 25;

let cachedEntries: PathEntry[] | null = null;
let lastLoadedAt: number | null = null;
let ignorePromise: Promise<Ignore> | null = null;

const normalizePath = (entryPath: string): string =>
	entryPath.replaceAll(path.sep, '/');

const sortEntries = (entries: PathEntry[]): PathEntry[] =>
	entries.slice().sort((a, b) => {
		if (a.type === b.type) {
			return a.path.localeCompare(b.path);
		}
		return a.type === 'directory' ? -1 : 1;
	});

const ensureIgnoreMatcher = async (): Promise<Ignore> => {
	if (!ignorePromise) {
		ignorePromise = (async () => {
			const matcher = (createIgnore as unknown as () => Ignore)();
			matcher.add(DEFAULT_IGNORES);
			try {
				const gitignoreContents = await fs.readFile(GITIGNORE_PATH, 'utf8');
				matcher.add(gitignoreContents);
			} catch (error: unknown) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
					loggingService.warn('Failed to read .gitignore', {
						error: error instanceof Error ? error.message : String(error),
						path: GITIGNORE_PATH,
					});
				}
			}
			return matcher;
		})();
	}
	return ignorePromise!;
};

const loadWorkspaceEntries = async (): Promise<PathEntry[]> => {
	const matcher = await ensureIgnoreMatcher();
	const results = (await fg('**/*', {
		cwd: workspaceRoot,
		dot: false,
		ignore: DEFAULT_IGNORES,
		onlyFiles: false,
		unique: true,
		objectMode: true,
		followSymbolicLinks: false,
		suppressErrors: true,
		deep: MAX_SCAN_DEPTH,
	})) as Entry[];

	const entries = results
		.filter(entry => entry.path.length > 0)
		.map(entry => {
			const normalized = normalizePath(entry.path);
			const isDirectory = entry.dirent?.isDirectory() ?? false;
			const entryType: PathEntry['type'] = isDirectory
				? 'directory'
				: 'file';
			return {
				path: normalized,
				type: entryType,
			};
		})
		.filter(entry =>
			!matcher.ignores(
				entry.type === 'directory' ? `${entry.path}/` : entry.path,
			),
		);

	return sortEntries(entries);
};

export const getWorkspaceEntries = async (): Promise<PathEntry[]> => {
	if (!cachedEntries) {
		cachedEntries = await loadWorkspaceEntries();
		lastLoadedAt = Date.now();
	}

	return cachedEntries;
};

export const refreshWorkspaceEntries = async (): Promise<PathEntry[]> => {
	cachedEntries = null;
	return getWorkspaceEntries();
};

export const getWorkspaceRoot = (): string => workspaceRoot;

export const getWorkspaceEntriesMeta = () => ({
	lastLoadedAt,
	totalEntries: cachedEntries?.length ?? 0,
});
