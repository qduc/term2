/** Pure helpers for the message box: `@` mentions and pasted or dropped images. No React here. */
import type { ComposerImage } from './shell-machine';
import type { ImageAttachmentPayload } from './types';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export function fileToComposerImage(file: File): Promise<ComposerImage> {
  return new Promise((resolve, reject) => {
    if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
      reject(new Error(`Unsupported image type (${file.type || 'unknown'}). Use PNG, JPEG, WebP, or GIF.`));
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      reject(new Error(`Image “${file.name || 'clipboard'}” is larger than 5 MB.`));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read image file.'));
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      const comma = dataUrl.indexOf(',');
      if (comma < 0) {
        reject(new Error('Invalid image encoding.'));
        return;
      }
      resolve({
        id: crypto.randomUUID(),
        name: file.name || 'image',
        type: 'image',
        mediaType: file.type as ImageAttachmentPayload['mediaType'],
        data: dataUrl.slice(comma + 1),
        previewUrl: dataUrl,
      });
    };
    reader.readAsDataURL(file);
  });
}

export function extractAtMention(text: string, cursor: number): { start: number; query: string } | null {
  const before = text.slice(0, cursor);
  const match = before.match(/(?:^|\s)@([^\s@]*)$/u);
  if (!match) return null;
  const query = match[1] ?? '';
  const start = cursor - query.length - 1;
  return { start, query };
}
