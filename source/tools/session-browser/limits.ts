// Matches the default tool-result byte cap (output trim maxCharacters); a larger
// budget would only produce a bounded-failure envelope for non-scripted calls.
export const MAX_SESSION_BROWSER_CHARS = 40_000;
