const APP_HORIZONTAL_PADDING = 4;
const DEFAULT_PROMPT_WIDTH = 2;
const SHELL_PROMPT_WIDTH = 2;
const REJECTION_PROMPT_WIDTH = 5;

export type InputWidthOptions = {
  terminalColumns?: number;
  waitingForRejectionReason: boolean;
  isShellMode: boolean;
  promptLabel?: string;
};

const getPromptWidth = ({
  waitingForRejectionReason,
  isShellMode,
  promptLabel,
}: Omit<InputWidthOptions, 'terminalColumns'>): number => {
  if (promptLabel) {
    return promptLabel.length;
  }

  if (waitingForRejectionReason) {
    return REJECTION_PROMPT_WIDTH;
  }

  if (isShellMode) {
    return SHELL_PROMPT_WIDTH;
  }

  return DEFAULT_PROMPT_WIDTH;
};

export const calculateInputWidth = ({
  terminalColumns,
  waitingForRejectionReason,
  isShellMode,
  promptLabel,
}: InputWidthOptions): number =>
  Math.max(
    0,
    (terminalColumns ?? 0) -
      APP_HORIZONTAL_PADDING -
      getPromptWidth({
        waitingForRejectionReason,
        isShellMode,
        promptLabel,
      }),
  );
