import React, {createContext, useContext, useState, ReactNode, useCallback} from 'react';

export type InputMode = 'text' | 'slash_commands' | 'path_completion' | 'settings_completion';

interface InputContextType {
    input: string;
    setInput: (value: string) => void;
    mode: InputMode;
    setMode: (mode: InputMode) => void;
    cursorOffset: number;
    setCursorOffset: (offset: number) => void;
    triggerIndex: number | null;
    setTriggerIndex: (index: number | null) => void;
}

const InputContext = createContext<InputContextType | undefined>(undefined);

export const InputProvider = ({children}: {children: ReactNode}) => {
    const [input, setInput] = useState('');
    const [mode, setMode] = useState<InputMode>('text');
    const [cursorOffset, setCursorOffset] = useState(0);
    const [triggerIndex, setTriggerIndex] = useState<number | null>(null);

    return (
        <InputContext.Provider
            value={{
                input,
                setInput,
                mode,
                setMode,
                cursorOffset,
                setCursorOffset,
                triggerIndex,
                setTriggerIndex,
            }}
        >
            {children}
        </InputContext.Provider>
    );
};

export const useInputContext = () => {
    const context = useContext(InputContext);
    if (!context) {
        throw new Error('useInputContext must be used within an InputProvider');
    }
    return context;
};
