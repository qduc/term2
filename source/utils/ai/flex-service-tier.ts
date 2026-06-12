import { APICallError } from '@ai-sdk/provider';

const getErrorText = (error: unknown): string => {
  if (APICallError.isInstance(error)) {
    return [
      error.message,
      typeof error.responseBody === 'string' ? error.responseBody : '',
      typeof error.data === 'string' ? error.data : '',
      error.data && typeof error.data === 'object' ? JSON.stringify(error.data) : '',
    ].join('\n');
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

export function isFlexServiceTierTimeout(error: unknown): boolean {
  const text = getErrorText(error).toLowerCase();
  return (
    /"error_type"\s*:\s*"timeout"/.test(text) && /"code"\s*:\s*504/.test(text) && text.includes('operation was aborted')
  );
}
