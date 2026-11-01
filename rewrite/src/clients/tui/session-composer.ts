/** Per-session draft, attachment echo reconciliation and input-list ownership snapshots.
 * Installs no keyboard listener; the session retains modal/composer activation.
 */
import { useCallback, useRef, useState } from 'react';
import type { ImageRef } from 'ink-prompt';
import type { WireContent } from '../../protocol/direct-wire.js';
import type { TuiState } from './state.js';
import { restoreAttachments } from './draft.js';
import { useEditor } from './editor.js';

export function useSessionComposer(state: TuiState) {
  const [images, setImages] = useState<ImageRef[]>([]);
  const ignoreInitialImages = useRef(false);
  const onImagesChange = useCallback((next: ImageRef[]) => {
    if (ignoreInitialImages.current) {
      ignoreInitialImages.current = false;
      return;
    }
    setImages((previous) =>
      previous.length === next.length &&
      previous.every((image, index) => {
        const other = next[index];
        return (
          other &&
          image.id === other.id &&
          image.data === other.data &&
          image.mimeType === other.mimeType &&
          image.byteSize === other.byteSize &&
          image.displayNumber === other.displayNumber
        );
      })
        ? previous
        : next,
    );
  }, []);
  const [otherParts, setOtherParts] = useState<readonly WireContent[]>([]);
  const [originalParts, setOriginalParts] = useState<readonly WireContent[]>([]);
  const [editing, setEditing] = useState<{
    id: string;
    restoreText: string;
    restoreCursor: number;
    restoreImages: ImageRef[];
    restoreOther: readonly WireContent[];
    restoreOriginal: readonly WireContent[];
    knownParts?: readonly WireContent[];
  } | null>(null);
  const editor = useEditor(
    state.messages
      .filter((message) => message.role === 'user')
      .map((message) => ({ text: message.historyText ?? message.text, attachments: message.attachments ?? [] })),
  );
  // The remounted editor first reports its empty internal images before syncing props.
  const replaceInput = (text: string, cursor?: number) => {
    ignoreInitialImages.current = true;
    editor.replace(text, cursor);
  };
  const answerOwners = useRef<readonly string[] | null>(null);
  const queueOwners = useRef<readonly string[] | null>(null);
  const changeInput = (value: string) => {
    if (/^\/answer(?:\s|$)/.test(value)) {
      if (!answerOwners.current) answerOwners.current = state.interactions.map((item) => item.id);
    } else {
      answerOwners.current = null;
    }
    if (/^\/queue(?:\s|$)/.test(value)) {
      if (!queueOwners.current) queueOwners.current = state.queue.map((item) => item.id);
    } else {
      queueOwners.current = null;
    }
    editor.change(value);
  };

  const restoreDraft = (
    draft: { readonly text: string; readonly attachments: readonly WireContent[] },
    cursor?: number,
  ) => {
    const restored = restoreAttachments(draft.attachments);
    replaceInput(draft.text, cursor);
    setImages(restored.images);
    setOtherParts(restored.other);
    setOriginalParts(draft.attachments);
  };
  return {
    images,
    setImages,
    onImagesChange,
    otherParts,
    setOtherParts,
    originalParts,
    setOriginalParts,
    editing,
    setEditing,
    editor,
    replaceInput,
    changeInput,
    restoreDraft,
    answerOwners,
    queueOwners,
  };
}
