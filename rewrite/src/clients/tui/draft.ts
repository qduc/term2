import { randomUUID } from 'node:crypto';
import type { ImageRef } from 'ink-prompt';
import type { WireContent } from '../../protocol/direct-wire.js';

/** Convert direct wire attachments to editor images, retaining non-image parts separately. */
export function restoreAttachments(parts: readonly WireContent[]): { images: ImageRef[]; other: WireContent[] } {
  const images: ImageRef[] = [];
  const other: WireContent[] = [];
  for (const part of parts) {
    if (part.type === 'image')
      images.push({
        id: randomUUID(),
        data: part.data,
        mimeType: part.mediaType,
        byteSize: Buffer.from(part.data, 'base64').length,
        displayNumber: images.length + 1,
      });
    else other.push(part);
  }
  return { images, other };
}

/** Preserve raw base64 image bytes in the direct public content shape. */
export function wireImages(images: readonly ImageRef[], originals: readonly WireContent[] = []): WireContent[] {
  const remaining = [...originals];
  return images.map((image) => {
    const index = remaining.findIndex(
      (part) => part.type === 'image' && part.data === image.data && part.mediaType === image.mimeType,
    );
    if (index >= 0) return remaining.splice(index, 1)[0];
    return { type: 'image', mediaType: image.mimeType, data: image.data };
  });
}

/** Keep restored attachment ordering and metadata when the editor changes only some images. */
export function wireAttachments(
  images: readonly ImageRef[],
  other: readonly WireContent[],
  originals: readonly WireContent[],
): WireContent[] {
  const remaining = [...other, ...wireImages(images, originals)];
  const ordered: WireContent[] = [];
  for (const part of originals) {
    const index = remaining.findIndex((item) => item === part);
    if (index >= 0) ordered.push(...remaining.splice(index, 1));
  }
  return [...ordered, ...remaining];
}

/** Keep the first text part as the composer primary; preserve every other part in order. */
export function primaryDraft(content: readonly WireContent[]) {
  const primary = content.findIndex((part) => part.type === 'text');
  const first = content[primary];
  return {
    text: first?.type === 'text' ? first.text : '',
    attachments: content.filter((_part, index) => index !== primary),
  };
}

/** ink-prompt image blocks are editor-only; paste-text blocks are already expanded on submit. */
export function cleanImageMarkers(text: string): string {
  return text.replace(/\uE000i:[^\uE000\uE001]*\uE001/g, '');
}
