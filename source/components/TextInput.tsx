import React, {useState, useEffect, useRef} from 'react';
import {Box, Text, useStdin} from 'ink';

// --- Types ---

interface TextInputProps {
	/**
	 * The value of the input.
	 */
	value: string;

	/**
	 * Handler called when value changes.
	 */
	onChange: (value: string) => void;

	/**
	 * Handler called when "Enter" is pressed.
	 */
	onSubmit?: (value: string) => void;

	/**
	 * Text to display when value is empty.
	 */
	placeholder?: string;

	/**
	 * Whether the input is currently focused and accepting input.
	 */
	focus?: boolean;

	/**
	 * Character to mask input with (e.g. '*' for passwords).
	 */
	mask?: string;

	/**
	 * Whether to allow multi-line input.
	 */
	multiLine?: boolean;
}

// --- Component ---

export const TextInput: React.FC<TextInputProps> = ({
	value,
	onChange,
	onSubmit,
	placeholder = '',
	focus = true,
	mask,
	multiLine = false,
}) => {
	// Track cursor position locally
	const [cursorOffset, setCursorOffset] = useState(value.length);

	// Sync cursor if value changes externally
	useEffect(() => {
		setCursorOffset(prev => Math.min(prev, value.length));
	}, [value]);

	const {stdin, setRawMode, isRawModeSupported} = useStdin();
	const bufferRef = useRef('');

	useEffect(() => {
		if (!isRawModeSupported || !focus) return;

		setRawMode(true);

		const handleData = (data: Buffer) => {
			const chunk = data.toString();
			bufferRef.current += chunk;

			// Process complete sequences
			while (bufferRef.current.length > 0) {
				const seq = bufferRef.current;
				let consumed = 0;

				if (seq.startsWith('\x1b')) {
					// Escape sequence
					if (seq.length === 1) {
						// Wait for more data to determine if it's a sequence or just ESC
						break;
					}

					if (seq.startsWith('\x1b[')) {
						// CSI Sequence
						if (seq === '\x1b[H' || seq.startsWith('\x1b[1~')) {
							// Home
							setCursorOffset(0);
							consumed = seq === '\x1b[H' ? 3 : 4;
						} else if (
							seq === '\x1b[F' ||
							seq.startsWith('\x1b[4~')
						) {
							// End
							setCursorOffset(value.length);
							consumed = seq === '\x1b[F' ? 3 : 4;
						} else if (seq.startsWith('\x1b[3~')) {
							// Delete
							if (cursorOffset < value.length) {
								const nextValue =
									value.slice(0, cursorOffset) +
									value.slice(cursorOffset + 1);
								onChange(nextValue);
							}
							consumed = 4;
						} else if (seq.startsWith('\x1b[D')) {
							// Left arrow
							setCursorOffset(Math.max(0, cursorOffset - 1));
							consumed = 3;
						} else if (seq.startsWith('\x1b[C')) {
							// Right arrow
							setCursorOffset(
								Math.min(value.length, cursorOffset + 1),
							);
							consumed = 3;
						} else {
							// Unknown or incomplete CSI sequence
							// CSI structure: ESC [ <params> <final>
							// Params/Intermediate: 0x20-0x3F
							// Final: 0x40-0x7E
							const match = seq.match(
								/^\x1b\[[\x20-\x3F]*[\x40-\x7E]/,
							);
							if (match) {
								// Consume unknown complete sequence
								consumed = match[0].length;
							} else {
								// Check if it looks like a partial CSI sequence
								if (/^\x1b\[[\x20-\x3F]*$/.test(seq)) {
									break; // Wait for more
								}
								// Invalid CSI, consume ESC to avoid getting stuck
								consumed = 1;
							}
						}
					} else if (seq.startsWith('\x1bO')) {
						// SS3 Sequence (often cursor keys)
						if (seq.length < 3) {
							break;
						}
						const code = seq[2];
						if (code === 'D') {
							// Left
							setCursorOffset(Math.max(0, cursorOffset - 1));
						} else if (code === 'C') {
							// Right
							setCursorOffset(
								Math.min(value.length, cursorOffset + 1),
							);
						} else if (code === 'H') {
							// Home
							setCursorOffset(0);
						} else if (code === 'F') {
							// End
							setCursorOffset(value.length);
						}
						consumed = 3;
					} else {
						// Unknown escape sequence, consume ESC
						consumed = 1;
					}
				} else if (seq === '\x7f' || seq === '\b') {
					// Backspace
					if (cursorOffset > 0) {
						const splitIndex = cursorOffset - 1;
						const nextValue =
							value.slice(0, splitIndex) +
							value.slice(splitIndex + 1);
						onChange(nextValue);
						setCursorOffset(Math.max(0, cursorOffset - 1));
					}
					consumed = 1;
				} else if (seq === '\r' || seq === '\n') {
					// Enter
					if (multiLine) {
						const nextValue =
							value.slice(0, cursorOffset) +
							'\n' +
							value.slice(cursorOffset);
						onChange(nextValue);
						setCursorOffset(cursorOffset + 1);
					} else {
						if (onSubmit) onSubmit(value);
					}
					consumed = 1;
				} else if (seq.charCodeAt(0) < 32) {
					// Control characters
					const code = seq.charCodeAt(0);
					if (code === 1) {
						// Ctrl+A (Home)
						setCursorOffset(0);
					} else if (code === 5) {
						// Ctrl+E (End)
						setCursorOffset(value.length);
					} else if (code === 21) {
						// Ctrl+U (Clear line)
						onChange('');
						setCursorOffset(0);
					} else if (code === 23) {
						// Ctrl+W (Delete word)
						const before = value.slice(0, cursorOffset);
						const after = value.slice(cursorOffset);
						// Remove trailing spaces
						const trimmedBefore = before.replace(/\s+$/, '');
						// Find last space
						const lastSpace = trimmedBefore.lastIndexOf(' ');
						const newBefore =
							lastSpace === -1
								? ''
								: trimmedBefore.slice(0, lastSpace + 1);
						onChange(newBefore + after);
						setCursorOffset(newBefore.length);
					} else if (code === 4) {
						// Ctrl+D
						if (onSubmit) onSubmit(value);
					}
					consumed = 1;
				} else {
					// Printable characters (support for paste by inserting multiple at once)
					const printableChars = [];
					for (let i = 0; i < seq.length; i++) {
						const char = seq[i];
						const code = char.charCodeAt(0);
						if (code >= 32 && code !== 127) {
							// printable ASCII, exclude DEL
							printableChars.push(char);
						} else {
							break;
						}
					}
					if (printableChars.length > 0) {
						const printable = printableChars.join('');
						const nextValue =
							value.slice(0, cursorOffset) +
							printable +
							value.slice(cursorOffset);
						onChange(nextValue);
						setCursorOffset(cursorOffset + printable.length);
						consumed = printableChars.length;
					} else {
						// Unknown or non-printable, consume 1 to avoid getting stuck
						consumed = 1;
					}
				}

				bufferRef.current = bufferRef.current.slice(consumed);
			}
		};

		stdin.on('data', handleData);

		return () => {
			stdin.off('data', handleData);
			setRawMode(false);
		};
	}, [
		focus,
		value,
		cursorOffset,
		onChange,
		onSubmit,
		stdin,
		setRawMode,
		isRawModeSupported,
		multiLine,
	]);

	// Rendering Logic
	const displayText = mask ? mask.repeat(value.length) : value;
	// If empty, show placeholder
	if (value.length === 0 && placeholder) {
		return (
			<Box>
				<Text color="grey">
					{placeholder}{' '}
					{focus ? (
						<Text color="blue" inverse>
							{' '}
						</Text>
					) : null}
				</Text>
			</Box>
		);
	}

	// Helper: simple word-wrap preserving spaces when possible
	const wrapText = (text: string, width: number): string[] => {
		if (width <= 1) return [text];
		const parts = text.split(/(\s+)/);
		const lines: string[] = [];
		let current = '';

		for (const part of parts) {
			if (part.length === 0) continue;
			if (current.length + part.length <= width) {
				current += part;
			} else {
				if (current.length > 0) {
					lines.push(current);
				}
				// If the part itself is longer than width, break it
				if (part.length > width) {
					for (let i = 0; i < part.length; i += width) {
						lines.push(part.slice(i, i + width));
					}
					current = '';
				} else {
					current = part;
				}
			}
		}

		if (current.length > 0) lines.push(current);
		if (lines.length === 0) lines.push('');
		return lines;
	};

	// Determine display lines: either explicit newlines or wrapped lines
	const termWidth = Math.max(1, process.stdout?.columns ?? 80);
	let lines: string[];
	const hasNewlines = displayText.includes('\n');
	if (hasNewlines) {
		lines = displayText.split('\n');
	} else {
		lines = wrapText(displayText, termWidth);
	}

	// Calculate cursor position across the lines
	let currentPos = 0;
	let cursorLine = 0;
	let cursorCol = 0;
	for (let i = 0; i < lines.length; i++) {
		const lineLen = lines[i].length;
		if (cursorOffset <= currentPos + lineLen) {
			cursorLine = i;
			cursorCol = cursorOffset - currentPos;
			break;
		}
		// If original text had explicit newlines, account for the '\n' char
		currentPos += hasNewlines ? lineLen + 1 : lineLen;
	}

	// If cursor wasn't assigned (cursor at very end), put it at final position
	if (
		cursorOffset === value.length &&
		cursorLine === 0 &&
		cursorCol === 0 &&
		lines.length > 0
	) {
		cursorLine = lines.length - 1;
		cursorCol = lines[lines.length - 1].length;
	}

	return (
		<Box flexDirection="column">
			{lines.map((line, index) => {
				if (index === cursorLine) {
					const before = line.slice(0, cursorCol);
					const at = line.slice(cursorCol, cursorCol + 1) || ' ';
					const after = line.slice(cursorCol + 1);
					return (
						<Box key={index}>
							<Text>{before}</Text>
							{focus ? (
								<Text color="cyan" inverse>
									{at}
								</Text>
							) : (
								<Text>{at}</Text>
							)}
							<Text>{after}</Text>
						</Box>
					);
				} else {
					return <Text key={index}>{line}</Text>;
				}
			})}
		</Box>
	);
};

export default TextInput;
