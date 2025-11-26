import fs from 'node:fs';
import path from 'node:path';
import envPaths from 'env-paths';

const paths = envPaths('term2');
// Use log directory for state/history files (on Linux: ~/.local/state/term2-nodejs)
const HISTORY_FILE = path.join(paths.log, 'history.json');
const MAX_HISTORY_SIZE = 1000;

interface HistoryData {
	messages: string[];
}

/**
 * Service for managing user input history.
 * Saves messages to XDG state directory (~/.local/state/term2/history.json on Linux).
 */
class HistoryService {
	private messages: string[] = [];

	constructor() {
		this.load();
	}

	/**
	 * Load history from disk
	 */
	private load(): void {
		try {
			if (fs.existsSync(HISTORY_FILE)) {
				const data = fs.readFileSync(HISTORY_FILE, 'utf-8');
				const parsed = JSON.parse(data) as HistoryData;
				this.messages = Array.isArray(parsed.messages) ? parsed.messages : [];
			}
		} catch (error) {
			// If we can't load history, start with empty array
			console.error('Failed to load history:', error);
			this.messages = [];
		}
	}

	/**
	 * Save history to disk
	 */
	private save(): void {
		try {
			// Ensure directory exists
			const dir = path.dirname(HISTORY_FILE);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, {recursive: true});
			}

			const data: HistoryData = {
				messages: this.messages,
			};

			fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2), 'utf-8');
		} catch (error) {
			console.error('Failed to save history:', error);
		}
	}

	/**
	 * Add a message to history
	 */
	addMessage(message: string): void {
		// Don't add empty or duplicate messages
		if (!message.trim()) {
			return;
		}

		// Remove duplicates (if the same message is already the most recent)
		if (
			this.messages.length > 0 &&
			this.messages[this.messages.length - 1] === message
		) {
			return;
		}

		this.messages.push(message);

		// Trim history if it exceeds max size
		if (this.messages.length > MAX_HISTORY_SIZE) {
			this.messages = this.messages.slice(-MAX_HISTORY_SIZE);
		}

		this.save();
	}

	/**
	 * Get all messages
	 */
	getMessages(): string[] {
		return [...this.messages];
	}

	/**
	 * Clear all history
	 */
	clear(): void {
		this.messages = [];
		this.save();
	}
}

export const historyService = new HistoryService();
