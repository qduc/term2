import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useStdin } from 'ink';

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
}

// --- Component ---

export const TextInput: React.FC<TextInputProps> = ({
    value,
    onChange,
    onSubmit,
    placeholder = '',
    focus = true,
    mask,
}) => {
    // Track cursor position locally
    const [cursorOffset, setCursorOffset] = useState(value.length);

    // Sync cursor if value changes externally
    useEffect(() => {
        setCursorOffset((prev) => Math.min(prev, value.length));
    }, [value]);

    const { stdin, setRawMode, isRawModeSupported } = useStdin();
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
                let consumed = 1;

                if (seq.startsWith('\x1b[')) {
                    // Escape sequence
                    if (seq === '\x1b[H' || seq.startsWith('\x1b[1~')) {
                        // Home
                        setCursorOffset(0);
                        consumed = seq === '\x1b[H' ? 3 : 4;
                    } else if (seq === '\x1b[F' || seq.startsWith('\x1b[4~')) {
                        // End
                        setCursorOffset(value.length);
                        consumed = seq === '\x1b[F' ? 3 : 4;
                    } else if (seq.startsWith('\x1b[3~')) {
                        // Delete
                        if (cursorOffset < value.length) {
                            const nextValue = value.slice(0, cursorOffset) + value.slice(cursorOffset + 1);
                            onChange(nextValue);
                        }
                        consumed = 4;
                    } else if (seq.startsWith('\x1b[D')) {
                        // Left arrow
                        setCursorOffset(Math.max(0, cursorOffset - 1));
                        consumed = 3;
                    } else if (seq.startsWith('\x1b[C')) {
                        // Right arrow
                        setCursorOffset(Math.min(value.length, cursorOffset + 1));
                        consumed = 3;
                    } else if (seq.length >= 3) {
                        // Incomplete sequence, wait for more
                        break;
                    }
                } else if (seq === '\x7f' || seq === '\b') {
                    // Backspace
                    if (cursorOffset > 0) {
                        const splitIndex = cursorOffset - 1;
                        const nextValue = value.slice(0, splitIndex) + value.slice(splitIndex + 1);
                        onChange(nextValue);
                        setCursorOffset(Math.max(0, cursorOffset - 1));
                    }
                } else if (seq === '\r' || seq === '\n') {
                    // Enter
                    if (onSubmit) onSubmit(value);
                } else if (seq.charCodeAt(0) >= 32 && seq.charCodeAt(0) < 127) {
                    // Printable character
                    const nextValue = value.slice(0, cursorOffset) + seq + value.slice(cursorOffset);
                    onChange(nextValue);
                    setCursorOffset(cursorOffset + 1);
                }

                bufferRef.current = bufferRef.current.slice(consumed);
            }
        };

        stdin.on('data', handleData);

        return () => {
            stdin.off('data', handleData);
            setRawMode(false);
        };
    }, [focus, value, cursorOffset, onChange, onSubmit, stdin, setRawMode, isRawModeSupported]);

    // Rendering Logic
    const displayText = mask ? mask.repeat(value.length) : value;

    // If empty, show placeholder
    if (value.length === 0 && placeholder) {
        return (
            <Box>
                <Text color="grey">
                    {placeholder} {focus ? <Text color="blue" inverse> </Text> : null}
                </Text>
            </Box>
        );
    }

    // Split text at cursor for styling
    const textBeforeCursor = displayText.slice(0, cursorOffset);
    const charAtCursor = displayText.slice(cursorOffset, cursorOffset + 1) || ' ';
    const textAfterCursor = displayText.slice(cursorOffset + 1);

    return (
        <Box>
            <Text>{textBeforeCursor}</Text>
            {focus ? (
                <Text color="cyan" inverse>
                    {charAtCursor}
                </Text>
            ) : (
                <Text>{charAtCursor}</Text>
            )}
            <Text>{textAfterCursor}</Text>
        </Box>
    );
};

export default TextInput;