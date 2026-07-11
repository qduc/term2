import type { RunAttachment } from './types.js';

/** Allowed textual MIME types for agent attachments. */
const TEXTUAL_MIME_TYPES: ReadonlySet<string> = new Set([
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'text/x-rst',
  'text/xml',
  'text/html',
  'text/css',
  'text/javascript',
  'text/typescript',
  'text/x-typescript',
  'text/x-python',
  'text/x-java',
  'text/x-c',
  'text/x-c++',
  'text/x-csharp',
  'text/x-go',
  'text/x-rust',
  'text/x-ruby',
  'text/x-sh',
  'text/x-shellscript',
  'text/yaml',
  'text/x-yaml',
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/x-http',
]);

/**
 * Validate an attachment's MIME type. Only textual MIME types are supported;
 * binary types (image/*, application/octet-stream, application/zip, etc.)
 * and unknown types produce a typed validation error.
 */
function validateMimeType(mimeType: string | undefined): string | undefined {
  if (!mimeType) return undefined; // no MIME type = accepted (treat as text/plain)
  const normalized = mimeType.toLowerCase().trim();
  if (TEXTUAL_MIME_TYPES.has(normalized)) return undefined;
  if (normalized.startsWith('text/')) return undefined; // all text/* types are accepted
  if (normalized.startsWith('application/json')) return undefined;
  if (normalized.startsWith('application/xml')) return undefined;
  if (normalized === 'application/javascript' || normalized === 'application/typescript') return undefined;
  return `Unsupported MIME type "${mimeType}": only textual content types are supported. Binary types (image/*, application/octet-stream, etc.) are not accepted.`;
}

/** Validate that content is a non-empty string. */
function validateContent(content: string): string | undefined {
  if (typeof content !== 'string') {
    return 'Attachment content must be a string.';
  }
  if (content.length === 0) {
    return 'Attachment content must not be empty.';
  }
  return undefined;
}

/** Validate that the name is a non-empty string without path separators. */
function validateName(name: string): string | undefined {
  if (typeof name !== 'string') {
    return 'Attachment name must be a string.';
  }
  if (name.length === 0) {
    return 'Attachment name must not be empty.';
  }
  if (name.includes('/') || name.includes('\\')) {
    return `Attachment name must not contain path separators: "${name}". Attachments are supplied data, not filesystem references.`;
  }
  return undefined;
}

/**
 * Result of validating a single attachment.
 */
export interface AttachmentValidationResult {
  errors: string[];
}

/**
 * Validate a single attachment against the contract: textual content only,
 * valid names, and deterministic content.
 */
export function validateAttachment(attachment: RunAttachment): AttachmentValidationResult {
  const errors: string[] = [];
  const nameErr = validateName(attachment.name);
  if (nameErr) errors.push(nameErr);
  const contentErr = validateContent(attachment.content);
  if (contentErr) errors.push(contentErr);
  const mimeErr = validateMimeType(attachment.mimeType);
  if (mimeErr) errors.push(mimeErr);
  return { errors };
}

/**
 * Validate all attachments and return any errors found.
 */
export function validateAttachments(attachments: ReadonlyArray<RunAttachment>): AttachmentValidationResult {
  const allErrors: string[] = [];
  for (let i = 0; i < attachments.length; i++) {
    const result = validateAttachment(attachments[i]);
    for (const err of result.errors) {
      allErrors.push(`Attachment[${i}]: ${err}`);
    }
  }
  return { errors: allErrors };
}

/**
 * Serialize an attachment into a deterministic model-visible section.
 * Uses clear boundaries so the model can distinguish attachment content
 * from instructions and task.
 */
export function serializeAttachment(attachment: RunAttachment, index: number): string {
  const mimeLabel = attachment.mimeType ? ` (${attachment.mimeType})` : '';
  return `### Attachment ${index + 1}: ${attachment.name}${mimeLabel}\n\n` + '```\n' + attachment.content + '\n```';
}

/**
 * Serialize all attachments into a single model-visible text block.
 * Returns empty string when there are no attachments.
 */
export function serializeAttachments(attachments: ReadonlyArray<RunAttachment>): string {
  if (attachments.length === 0) return '';
  const parts = ['\n## Attachments\n'];
  for (let i = 0; i < attachments.length; i++) {
    parts.push(serializeAttachment(attachments[i], i));
    if (i < attachments.length - 1) parts.push('');
  }
  return parts.join('\n');
}
