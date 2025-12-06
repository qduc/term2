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

	/**
	 * Called whenever the cursor offset changes.
	 */
	onCursorChange?: (offset: number) => void;

	/**
	 * Optional external cursor override.
	 */
	cursorOverride?: number;
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
	onCursorChange,
	cursorOverride,
}) => {
	// Track cursor position locally
	const [cursorOffset, setCursorOffset] = useState(value.length);

	// Sync cursor if value changes externally
	useEffect(() => {
		setCursorOffset(prev => Math.min(prev, value.length));
	}, [value]);

	useEffect(() => {
		if (typeof cursorOverride === 'number') {
			const nextOffset = Math.max(0, Math.min(cursorOverride, value.length));
			setCursorOffset(nextOffset);
		}
	}, [cursorOverride, value.length]);

	// Use a ref to avoid dependency on onCursorChange callback
	const onCursorChangeRef = useRef(onCursorChange);
	useEffect(() => {
		onCursorChangeRef.current = onCursorChange;
	}, [onCursorChange]);

	useEffect(() => {
		if (onCursorChangeRef.current) {
			onCursorChangeRef.current(cursorOffset);
		}
	}, [cursorOffset]);

	const {stdin, setRawMode, isRawModeSupported} = useStdin();
	const bufferRef = useRef('');
	const cursorOffsetRef = useRef(cursorOffset);
	const valueRef = useRef(value);

	// Keep refs in sync with props/state
	useEffect(() => {
		cursorOffsetRef.current = cursorOffset;
	}, [cursorOffset]);

	useEffect(() => {
		valueRef.current = value;
	}, [value]);

	useEffect(() => {
		if (!isRawModeSupported || !focus) return;

		setRawMode(true);

		const handleData = (data: Buffer) => {
			const chunk = data.toString();
			bufferRef.current += chunk;

			// Use local state to track changes within the same event loop
			// to avoid stale state issues when processing multiple sequences (e.g. paste)
			let currentCursorOffset = cursorOffsetRef.current;
			let currentValue = valueRef.current;
			let valueChanged = false;
			let cursorChanged = false;

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
							currentCursorOffset = 0;
							cursorChanged = true;
							consumed = seq === '\x1b[H' ? 3 : 4;
						} else if (
							seq === '\x1b[F' ||
							seq.startsWith('\x1b[4~')
						) {
							// End
							currentCursorOffset = currentValue.length;
							cursorChanged = true;
							consumed = seq === '\x1b[F' ? 3 : 4;
						} else if (seq.startsWith('\x1b[3~')) {
							// Delete
							if (currentCursorOffset < currentValue.length) {
								const nextValue =
									currentValue.slice(0, currentCursorOffset) +
									currentValue.slice(currentCursorOffset + 1);
								currentValue = nextValue;
								valueChanged = true;
							}
							consumed = 4;
						} else if (seq.startsWith('\x1b[D')) {
							// Left arrow
							currentCursorOffset = Math.max(0, currentCursorOffset - 1);
							cursorChanged = true;
							consumed = 3;
						} else if (seq.startsWith('\x1b[C')) {
							// Right arrow
							currentCursorOffset = Math.min(
								currentValue.length,
								currentCursorOffset + 1,
							);
							cursorChanged = true;
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
							currentCursorOffset = Math.max(0, currentCursorOffset - 1);
							cursorChanged = true;
						} else if (code === 'C') {
							// Right
							currentCursorOffset = Math.min(
								currentValue.length,
								currentCursorOffset + 1,
							);
							cursorChanged = true;
						} else if (code === 'H') {
							// Home
							currentCursorOffset = 0;
							cursorChanged = true;
						} else if (code === 'F') {
							// End
							currentCursorOffset = currentValue.length;
							cursorChanged = true;
						}
						consumed = 3;
					} else {
						// Unknown escape sequence, consume ESC
						consumed = 1;
					}
				} else if (seq === '\x7f' || seq === '\b') {
					// Backspace
					if (currentCursorOffset > 0) {
						const splitIndex = currentCursorOffset - 1;
						const nextValue =
							currentValue.slice(0, splitIndex) +
							currentValue.slice(splitIndex + 1);
						currentValue = nextValue;
						valueChanged = true;
						currentCursorOffset = Math.max(0, currentCursorOffset - 1);
						cursorChanged = true;
					}
					consumed = 1;
				} else if (seq[0] === '\r') {
					// Handle carriage return: could be Enter, paste, or CRLF
					const isCRLF = bufferRef.current.startsWith('\r\n');
					const isSingleCR = seq === '\r' && !isCRLF;

					if (isSingleCR) {
						if (onSubmit) {
							// Plain Enter: submit
							onSubmit(currentValue);
							consumed = 1;
						} else if (multiLine) {
							// Insert newline if no submit handler
							const nextValue =
								currentValue.slice(0, currentCursorOffset) +
								'\n' +
								currentValue.slice(currentCursorOffset);
							currentValue = nextValue;
							valueChanged = true;
							currentCursorOffset += 1;
							cursorChanged = true;
							consumed = 1;
						} else {
							// Single-line, no submit: ignore
							consumed = 1;
						}
					} else {
						// Likely part of a paste or CRLF sequence; normalize to \n in multiLine
						if (multiLine) {
							const nextValue =
								currentValue.slice(0, currentCursorOffset) +
								'\n' +
								currentValue.slice(currentCursorOffset);
							currentValue = nextValue;
							valueChanged = true;
							currentCursorOffset += 1;
							cursorChanged = true;
						}
						// If CRLF, consume both to avoid double newline
						consumed = isCRLF ? 2 : 1;
					}
				} else if (seq.charCodeAt(0) < 32 && seq !== '\n') {
					// Control characters
					const code = seq.charCodeAt(0);
					if (code === 1) {
						// Ctrl+A (Home)
						currentCursorOffset = 0;
						cursorChanged = true;
					} else if (code === 5) {
						// Ctrl+E (End)
						currentCursorOffset = currentValue.length;
						cursorChanged = true;
					} else if (code === 21) {
						// Ctrl+U (Clear line)
						currentValue = '';
						valueChanged = true;
						currentCursorOffset = 0;
						cursorChanged = true;
					} else if (code === 23) {
						// Ctrl+W (Delete word)
						const before = currentValue.slice(0, currentCursorOffset);
						const after = currentValue.slice(currentCursorOffset);
						// Remove trailing spaces
						const trimmedBefore = before.replace(/\s+$/, '');
						// Find last space
						const lastSpace = trimmedBefore.lastIndexOf(' ');
						const newBefore =
							lastSpace === -1
								? ''
								: trimmedBefore.slice(0, lastSpace + 1);
						currentValue = newBefore + after;
						valueChanged = true;
						currentCursorOffset = newBefore.length;
						cursorChanged = true;
					} else if (code === 4) {
						// Ctrl+D
						if (onSubmit) onSubmit(currentValue);
					}
					consumed = 1;
				} else {
					// Printable characters (support for paste by inserting multiple at once)
					const printableChars: string[] = [];
					for (let i = 0; i < seq.length; i++) {
						const char = seq[i];
						const code = char.charCodeAt(0);
						if (
							(code >= 32 && code !== 127) ||
							(multiLine && code === 10)
						) {
							// printable ASCII, exclude DEL. Allow \n (Ctrl+J) if multiLine.
							printableChars.push(char);
						} else {
							break;
						}
					}
					if (printableChars.length > 0) {
						const printable = printableChars.join('');
						const nextValue =
							currentValue.slice(0, currentCursorOffset) +
							printable +
							currentValue.slice(currentCursorOffset);
						currentValue = nextValue;
						valueChanged = true;
						currentCursorOffset += printable.length;
						cursorChanged = true;
						consumed = printableChars.length;
					} else {
						// Unknown or non-printable, consume 1 to avoid getting stuck
						consumed = 1;
					}
				}

				bufferRef.current = bufferRef.current.slice(consumed);
			}

			if (valueChanged) {
				valueRef.current = currentValue;
				onChange(currentValue);
			}
			if (cursorChanged && currentCursorOffset !== cursorOffsetRef.current) {
				cursorOffsetRef.current = currentCursorOffset;
				setCursorOffset(currentCursorOffset);
			}
		};

		stdin.on('data', handleData);

		return () => {
			stdin.off('data', handleData);
			setRawMode(false);
		};
	}, [
		focus,
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
