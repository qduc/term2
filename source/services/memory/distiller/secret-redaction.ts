/**
 * Content-level secret redaction for text that leaves the machine or becomes
 * durable memory. Key-name redaction (provider traffic) cannot see a token
 * pasted into a chat message, so this matches credential shapes in prose.
 *
 * Tuned toward recall: a false positive only drops a sentence from a
 * transcript excerpt or blocks one memory write.
 */
const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]{3,}@/gi,
  /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|token|passw(?:or)?d|credential)[A-Za-z0-9_]*)(\s*[:=]\s*)("[^"\n]{4,}"|'[^'\n]{4,}'|[^\s"',;]{8,})/gi,
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of PATTERNS) {
    result = result.replace(pattern, (match, name: string | undefined, separator: string | undefined) => {
      // Keep the key name so the surrounding sentence still reads.
      // No-capture regexes pass the match offset and input string in these
      // positions; only the assignment pattern supplies string captures here.
      if (typeof name === 'string' && typeof separator === 'string' && /[:=]/.test(separator))
        return `${name}${separator}[REDACTED]`;
      if (/^(Bearer|Basic)\s/i.test(match)) return `${match.split(/\s+/)[0]} [REDACTED]`;
      return '[REDACTED]';
    });
  }
  return result;
}

export function containsSecret(text: string): boolean {
  return redactSecrets(text) !== text;
}
