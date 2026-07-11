import { describe, it, expect } from 'vitest';
import {
  validateAttachment,
  validateAttachments,
  serializeAttachment,
  serializeAttachments,
} from './text-attachment.js';
import type { RunAttachment } from './types.js';

describe('validateAttachment', () => {
  it('accepts a valid text attachment', () => {
    const result = validateAttachment({
      name: 'readme.md',
      content: '# Hello World',
      mimeType: 'text/markdown',
    });
    expect(result.errors).toEqual([]);
  });

  it('accepts attachment without MIME type (defaults to text)', () => {
    const result = validateAttachment({
      name: 'notes.txt',
      content: 'plain text notes',
    });
    expect(result.errors).toEqual([]);
  });

  it('accepts application/json MIME type', () => {
    const result = validateAttachment({
      name: 'config.json',
      content: '{"key": "value"}',
      mimeType: 'application/json',
    });
    expect(result.errors).toEqual([]);
  });

  it('accepts text/* MIME type families', () => {
    const result = validateAttachment({
      name: 'script.py',
      content: 'print("hello")',
      mimeType: 'text/x-python',
    });
    expect(result.errors).toEqual([]);
  });

  it('rejects binary MIME types', () => {
    const result = validateAttachment({
      name: 'photo.png',
      content: '...',
      mimeType: 'image/png',
    });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('Unsupported MIME type');
  });

  it('rejects application/octet-stream', () => {
    const result = validateAttachment({
      name: 'blob.bin',
      content: '...',
      mimeType: 'application/octet-stream',
    });
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects attachment with path separators in name', () => {
    const result = validateAttachment({
      name: '../etc/passwd',
      content: '...',
    });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('path separator');
  });

  it('rejects attachment with backslash path separators', () => {
    const result = validateAttachment({
      name: '..\\windows\\system32',
      content: '...',
    });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('path separator');
  });

  it('rejects empty attachment name', () => {
    const result = validateAttachment({
      name: '',
      content: 'hello',
    });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('must not be empty');
  });

  it('rejects empty attachment content', () => {
    const result = validateAttachment({
      name: 'empty.txt',
      content: '',
    });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('must not be empty');
  });

  it('accumulates multiple errors for an invalid attachment', () => {
    const result = validateAttachment({
      name: '',
      content: '',
      mimeType: 'image/gif',
    });
    expect(result.errors.length).toBe(3);
  });
});

describe('validateAttachments', () => {
  it('returns no errors for an empty list', () => {
    const result = validateAttachments([]);
    expect(result.errors).toEqual([]);
  });

  it('returns errors indexed by attachment position', () => {
    const result = validateAttachments([
      { name: 'good.txt', content: 'ok' },
      { name: '', content: '' },
    ]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('Attachment[1]');
  });
});

describe('serializeAttachment', () => {
  it('produces deterministic output with clear boundaries', () => {
    const output = serializeAttachment({ name: 'notes.md', content: '# Title\nBody', mimeType: 'text/markdown' }, 0);
    expect(output).toContain('### Attachment 1: notes.md (text/markdown)');
    expect(output).toContain('```\n# Title\nBody\n```');
  });

  it('omits MIME type label when not specified', () => {
    const output = serializeAttachment({ name: 'readme.txt', content: 'Hello' }, 2);
    expect(output).toContain('### Attachment 3: readme.txt');
    expect(output).not.toContain('(');
  });
});

describe('serializeAttachments', () => {
  it('returns empty string for empty attachments', () => {
    expect(serializeAttachments([])).toBe('');
  });

  it('serializes multiple attachments with separators', () => {
    const output = serializeAttachments([
      { name: 'a.txt', content: 'A' },
      { name: 'b.txt', content: 'B' },
    ]);
    expect(output).toContain('## Attachments');
    expect(output).toContain('### Attachment 1: a.txt');
    expect(output).toContain('### Attachment 2: b.txt');
  });
});
