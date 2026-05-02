export const STOP_CHAR_REGEX = /[\s,;:()[\]{}<>]/;
export const SETTINGS_TRIGGER = '/settings ';
export const SETTINGS_RESET_TRIGGER = '/settings reset ';
export const AUTO_APPROVE_TRIGGER = '/auto-approve ';

const whitespaceRegex = /\s/;

export const findPathTrigger = (
  text: string,
  cursor: number,
  stopChars: RegExp = STOP_CHAR_REGEX,
): { start: number; query: string } | null => {
  if (cursor <= 0 || cursor > text.length) {
    return null;
  }

  for (let index = cursor - 1; index >= 0; index -= 1) {
    const char = text[index];
    if (char === '@') {
      const query = text.slice(index + 1, cursor);
      if (whitespaceRegex.test(query)) {
        return null;
      }
      return { start: index, query };
    }
    if (stopChars.test(char)) {
      break;
    }
  }

  return null;
};
