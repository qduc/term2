import {useCallback, useEffect, useMemo, useState} from 'react';
import Fuse from 'fuse.js';
import {
	getWorkspaceEntries,
	refreshWorkspaceEntries,
	type PathEntry,
} from '../services/file-service.js';
import {loggingService} from '../services/logging-service.js';

export type PathCompletionItem = PathEntry;

const MAX_RESULTS = 12;

export const usePathCompletion = () => {
	const [isOpen, setIsOpen] = useState(false);
	const [triggerIndex, setTriggerIndex] = useState<number | null>(null);
	const [query, setQuery] = useState('');
	const [entries, setEntries] = useState<PathEntry[]>([]);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const loadEntries = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const paths = await getWorkspaceEntries();
			setEntries(paths);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			setError(message);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		loadEntries().catch(error => {
			loggingService.error('Failed to load workspace entries', {
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}, [loadEntries]);

	const fuse = useMemo(() => {
		return new Fuse(entries, {
			keys: ['path'],
			threshold: 0.4,
			ignoreLocation: true,
		});
	}, [entries]);

	const filteredEntries = useMemo(() => {
		if (!query.trim()) {
			return entries.slice(0, MAX_RESULTS);
		}

		return fuse
			.search(query.trim())
			.map(result => result.item)
			.slice(0, MAX_RESULTS);
	}, [entries, fuse, query]);

	useEffect(() => {
		setSelectedIndex(prev => {
			if (filteredEntries.length === 0) {
				return 0;
			}
			return Math.min(prev, filteredEntries.length - 1);
		});
	}, [filteredEntries.length]);

	const open = useCallback((startIndex: number, initialQuery = '') => {
		setIsOpen(true);
		setTriggerIndex(startIndex);
		setQuery(initialQuery);
		setSelectedIndex(0);
	}, []);

	const close = useCallback(() => {
		setIsOpen(false);
		setTriggerIndex(null);
		setQuery('');
		setSelectedIndex(0);
	}, []);

	const updateQuery = useCallback((nextQuery: string) => {
		setQuery(nextQuery);
		setSelectedIndex(0);
	}, []);

	const moveUp = useCallback(() => {
		setSelectedIndex(prev => {
			if (filteredEntries.length === 0) {
				return 0;
			}
			return prev > 0 ? prev - 1 : filteredEntries.length - 1;
		});
	}, [filteredEntries.length]);

	const moveDown = useCallback(() => {
		setSelectedIndex(prev => {
			if (filteredEntries.length === 0) {
				return 0;
			}
			return prev < filteredEntries.length - 1 ? prev + 1 : 0;
		});
	}, [filteredEntries.length]);

	const getSelectedItem = useCallback(() => {
		if (filteredEntries.length === 0) {
			return undefined;
		}
		const safeIndex = Math.min(selectedIndex, filteredEntries.length - 1);
		return filteredEntries[safeIndex];
	}, [filteredEntries, selectedIndex]);

	const refresh = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const paths = await refreshWorkspaceEntries();
			setEntries(paths);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			setError(message);
		} finally {
			setLoading(false);
		}
	}, []);

	return {
		isOpen,
		triggerIndex,
		query,
		entries,
		filteredEntries,
		selectedIndex,
		loading,
		error,
		open,
		close,
		updateQuery,
		moveUp,
		moveDown,
		getSelectedItem,
		refresh,
	};
};
