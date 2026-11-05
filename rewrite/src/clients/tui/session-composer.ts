/** Per-session draft, attachment echo reconciliation and input-list ownership snapshots.
 * Installs no keyboard listener; the session retains modal/composer activation.
 */
import { useCallback, useRef, useState } from 'react';
import type { ImageRef } from 'ink-prompt';
import type { WireContent } from '../../protocol/direct-wire.js';
import type { QueueItem, TuiState } from './state.js';
import { primaryDraft, restoreAttachments, wireAttachments } from './draft.js';
import {
  cancelForegroundWithSteers,
  sendNativeCommand,
  previewConfirmation,
  queueAction,
  receiptNotice,
  submitText,
  WireCommandFailure,
} from './commands.js';
import { withSkillPrefix } from './skill-edit.js';
import { randomUUID } from 'node:crypto';
import type { TuiConnection } from './integration.js';
import { useEditor } from './editor.js';

export function useSessionComposer(state: TuiState, historySize: number, onNotice?: (message: string) => void) {
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
  const attachmentSnapshot = useRef({ images, otherParts, originalParts });
  attachmentSnapshot.current = { images, otherParts, originalParts };
  const [editing, setEditing] = useState<{
    id: string;
    restoreText: string;
    restoreCursor: number;
    restoreImages: ImageRef[];
    restoreOther: readonly WireContent[];
    restoreOriginal: readonly WireContent[];
    knownParts?: readonly WireContent[];
    skillPrefix?: string;
  } | null>(null);
  const editingSnapshot = useRef(editing);
  editingSnapshot.current = editing;
  const cancellationEpoch = useRef(0);
  const cancellationBarrier = useRef<Promise<void>>(Promise.resolve());
  const pendingCancel = useRef<Promise<string> | null>(null);
  const activeSubmission = useRef<{
    id: string;
    input: string;
    revision: number;
    imageIds: readonly string[];
    otherParts: readonly WireContent[];
    images: readonly ImageRef[];
    originalParts: readonly WireContent[];
  } | null>(null);
  const invalidatedEdits = useRef(new Map<string, { text?: string; attachments?: readonly WireContent[] }>());
  const editor = useEditor(
    state.messages
      .filter((message) => message.role === 'user')
      .map((message) => ({ text: message.historyText ?? message.text, attachments: message.attachments ?? [] })),
    historySize,
  );
  // The remounted editor first reports its empty internal images before syncing props.
  const replaceInput = (text: string, cursor?: number) => {
    ignoreInitialImages.current = true;
    editor.replace(text, cursor);
  };
  const changeInput = (value: string) => editor.change(value);

  const restoreDraft = (
    draft: { readonly text: string; readonly attachments: readonly WireContent[] },
    cursor?: number,
  ) => {
    const restored = restoreAttachments(draft.attachments);
    // Preserve existing image identities across editor remounts, including duplicates.
    const prior = [...attachmentSnapshot.current.images];
    const stableImages = restored.images.map((image) => {
      const index = prior.findIndex((item) => item.data === image.data && item.mimeType === image.mimeType);
      return index < 0 ? image : { ...image, id: prior.splice(index, 1)[0]!.id };
    });
    attachmentSnapshot.current = { images: stableImages, otherParts: restored.other, originalParts: draft.attachments };
    replaceInput(draft.text, cursor);
    setImages(stableImages);
    setOtherParts(restored.other);
    setOriginalParts(draft.attachments);
  };
  /** The reply contains only steers removed in the accepted cancellation batch. */
  const cancelInput = (
    connection: TuiConnection,
    turnId?: string,
    submitted?: string,
    submittedRevision?: number,
  ): Promise<string> => {
    if (pendingCancel.current)
      return pendingCancel.current.then((message) => {
        if (submitted) editor.accepted(submitted, true, [], submittedRevision);
        return message;
      });
    cancellationEpoch.current++;
    const operation = (async () => {
      const result = await cancelForegroundWithSteers(connection, turnId);
      if (submitted) editor.accepted(submitted, true, [], submittedRevision);
      // Legacy drops pending steers on cancellation (conversation-adapter's 'Pending submission was cancelled'):
      // none come back to the draft. A queue edit of a dropped steer ends and its saved draft returns.
      const edit = editingSnapshot.current;
      if (edit && result.returnedSteers.some((item) => item.messageId === edit.id)) {
        if (activeSubmission.current) invalidatedEdits.current.set(edit.id, {});
        editingSnapshot.current = null;
        setEditing(null);
        restoreDraft({
          text: edit.restoreText,
          attachments: wireAttachments(edit.restoreImages, edit.restoreOther, edit.restoreOriginal),
        });
      }
      // The routine success line is noise for Esc and Ctrl+C (the Stopped marker shows it); refusals still show.
      return result.message.startsWith('Cancellation requested') ? '' : result.message;
    })();
    pendingCancel.current = operation;
    const settled = operation.finally(() => {
      if (pendingCancel.current === operation) pendingCancel.current = null;
      cancellationEpoch.current++;
    });
    cancellationBarrier.current = Promise.allSettled([cancellationBarrier.current, settled]).then(() => undefined);
    return operation;
  };
  const beginSubmission = (
    input: string,
    submittedImages: readonly ImageRef[] = [],
    submittedOther: readonly WireContent[] = [],
  ) => {
    const requestId = randomUUID();
    activeSubmission.current = {
      id: requestId,
      input,
      revision: editor.revision(),
      imageIds: submittedImages.map((image) => image.id),
      otherParts: submittedOther,
      images: submittedImages,
      originalParts: attachmentSnapshot.current.originalParts,
    };
    return { requestId, submissionEpoch: cancellationEpoch.current, submittedRevision: editor.revision() };
  };
  const endSubmission = (requestId: string) => {
    if (activeSubmission.current?.id === requestId) {
      activeSubmission.current = null;
      invalidatedEdits.current.clear();
    }
  };
  const wasEditInvalidatedAfter = async (epoch: number, messageId: string, failed = false): Promise<boolean> => {
    if (epoch === cancellationEpoch.current && !pendingCancel.current) return false;
    await cancellationBarrier.current;
    const saved = invalidatedEdits.current.get(messageId);
    if (!saved) return false;
    invalidatedEdits.current.delete(messageId);
    if (failed && saved.text !== undefined) {
      const current = attachmentSnapshot.current;
      const existing = wireAttachments(current.images, current.otherParts, current.originalParts);
      restoreDraft({
        text: [editor.current(), saved.text].filter((text) => text.length > 0).join('\n\n'),
        attachments: [...existing, ...(saved.attachments ?? [])],
      });
      onNotice?.(
        'Queue edit failed or its outcome is unknown. Your edit is in the input; check the queue before resubmitting.',
      );
      return true;
    }
    return true;
  };
  const lateSteerNotice = (epoch: number, fallback: string) =>
    epoch === cancellationEpoch.current ? fallback : 'Cancelled. Your queued message is back in the input.';
  const restoreLateSteer = async (submitted: string, parts: readonly WireContent[]): Promise<void> => {
    const text = submitted;
    await cancellationBarrier.current;
    const current = attachmentSnapshot.current;
    const active = activeSubmission.current?.input === submitted ? activeSubmission.current : null;
    const currentImages = active
      ? current.images.filter((image) => !active.imageIds.includes(image.id))
      : current.images;
    const currentOther = active
      ? current.otherParts.filter((part) => !active.otherParts.includes(part))
      : current.otherParts;
    const attachments = wireAttachments(currentImages, currentOther, current.originalParts);
    const draft = editor.current();
    const isOriginal =
      draft === submitted &&
      activeSubmission.current?.input === submitted &&
      editor.revision() === activeSubmission.current.revision;
    const existing = isOriginal ? '' : draft;
    const recovered = [existing, text].filter((value) => value.length > 0).join('\n\n');
    restoreDraft({ text: recovered, attachments: [...attachments, ...parts] });
  };
  /** Remove only attachments belonging to the acknowledged send, never newer input. */
  const clearSubmittedParts = (submittedImages: readonly ImageRef[], submittedOther: readonly WireContent[]) => {
    const current = attachmentSnapshot.current;
    const ids = new Set(submittedImages.map((image) => image.id));
    const images = current.images.filter((image) => !ids.has(image.id));
    const otherParts = current.otherParts.filter((part) => !submittedOther.includes(part));
    const originalParts = wireAttachments(images, otherParts, current.originalParts);
    attachmentSnapshot.current = { images, otherParts, originalParts };
    setImages(images);
    setOtherParts(otherParts);
    setOriginalParts(originalParts);
  };
  /** One keyed rewind, including preview and optional explicit resend. */
  const rewindDraft = async (
    connection: TuiConnection,
    targetId: string,
    disposition: 'edit' | 'resend',
  ): Promise<string | null> => {
    const result = await sendNativeCommand(connection, { type: 'rewind', commandId: randomUUID(), targetId });
    if (result.kind !== 'finished' || result.receipt.outcome?.kind !== 'rewound') return receiptNotice(result);
    const draft = primaryDraft(result.receipt.outcome.draft.content);
    restoreDraft(draft);
    if (disposition === 'edit') return null; // legacy restores the turn without a notice
    const submittedRevision = editor.revision();
    const submittedAttachments = attachmentSnapshot.current;
    const message = await previewConfirmation(connection, draft.text, draft.attachments);
    if (message !== null) return `${message} Draft restored, not sent; press Enter to review and confirm.`;
    await submitText(connection, draft.text, draft.attachments, 'auto');
    if (editor.current() === draft.text && editor.revision() === submittedRevision) editor.change('');
    clearSubmittedParts(submittedAttachments.images, submittedAttachments.otherParts);
    return null;
  };
  /** Opens a queued message for editing, preserving the draft for cancellation. */
  const startQueueEdit = (item: QueueItem) => {
    const primary = item.content?.findIndex((part) => part.type === 'text') ?? -1;
    const parts = item.content?.filter((_part, index) => index !== primary);
    setEditing({
      id: item.id,
      restoreText: editor.current(),
      restoreCursor: editor.cursor.current,
      restoreImages: images,
      restoreOther: otherParts,
      restoreOriginal: originalParts,
      knownParts: parts,
      ...(item.skillEdit ? { skillPrefix: item.skillEdit.prefix } : {}),
    });
    restoreDraft({ text: item.skillEdit?.request ?? item.text, attachments: parts ?? [] });
  };
  /** Leaves a queued-message edit, restoring the draft it replaced; false when nothing was being edited. */
  const cancelQueueEdit = () => {
    if (!editing) return false;
    replaceInput(editing.restoreText, editing.restoreCursor);
    setImages(editing.restoreImages);
    setOtherParts(editing.restoreOther);
    setOriginalParts(editing.restoreOriginal);
    setEditing(null);
    return true;
  };
  /** Enter while editing a queued message: replaces it and returns the notice to show (null when superseded). */
  const submitQueueEdit = async (
    connection: TuiConnection,
    clean: string,
    submittedImages: readonly ImageRef[],
    epoch: number,
  ): Promise<string | null> => {
    if (!editing) return null;
    try {
      const parts = wireAttachments(submittedImages, otherParts, originalParts);
      if (!editing.knownParts && parts.length)
        throw new Error('Queued attachments are unavailable; cannot safely replace them.');
      const changed = editing.knownParts && JSON.stringify(parts) !== JSON.stringify(editing.knownParts);
      await queueAction(
        connection,
        'edit',
        editing.id,
        withSkillPrefix(editing.skillPrefix, clean),
        changed ? parts : undefined,
      );
      if (await wasEditInvalidatedAfter(epoch, editing.id)) return null;
      cancelQueueEdit();
      return null; // legacy saves a queued edit without a line
    } catch (error) {
      if (await wasEditInvalidatedAfter(epoch, editing.id, true)) return null;
      if (error instanceof WireCommandFailure && error.code === 'too_late') {
        setEditing(null);
        return editing.knownParts
          ? 'Queued input is no longer editable. Your edited draft and attachments are preserved; review before resubmitting.'
          : 'Queued input is no longer editable. Your edited text is preserved, but original attachments were unavailable; review before resubmitting.';
      }
      throw error;
    }
  };
  const restoreRejected = async (submitted: string) => {
    // MultilineInput clears its local text immediately after calling onSubmit.
    await Promise.resolve();
    const current = editor.current();
    replaceInput(!current || current === submitted ? submitted : `${submitted}\n${current}`);
  };
  const clearParts = () => {
    attachmentSnapshot.current = { images: [], otherParts: [], originalParts: [] };
    setImages([]);
    setOtherParts([]);
    setOriginalParts([]);
  };
  return {
    images,
    setImages,
    clearParts,
    clearSubmittedParts,
    cancelInput,
    steerRecovery: {
      beginSubmission,
      endSubmission,
      cancellationEpoch,
      wasEditInvalidatedAfter,
      restoreLateSteer,
      lateSteerNotice,
    },
    rewindDraft,
    onImagesChange,
    otherParts,
    setOtherParts,
    originalParts,
    setOriginalParts,
    editing,
    setEditing,
    editor: { ...editor, restoreRejected },
    replaceInput,
    changeInput,
    restoreDraft,
    startQueueEdit,
    cancelQueueEdit,
    submitQueueEdit,
  };
}
