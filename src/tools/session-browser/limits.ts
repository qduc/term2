// Upper bound a caller may request. Non-scripted results are also checked against
// the tools.maxOutputChars tool-result cap and fail with a bounded envelope above it.
export const MAX_SESSION_BROWSER_CHARS = 40_000;
