'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Loader2, Pencil, RotateCcw } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

/**
 * Rewinds to just before a turn's user message and sends `text` as a new turn.
 * Resolves to an error message, or null when the message was sent.
 */
export type ResendFromTurn = (turnId: string, text: string) => Promise<string | null>;

function laterTurnsNote(laterTurns: number): string {
  return laterTurns === 0 ? '' : ` and the ${laterTurns === 1 ? 'turn' : `${laterTurns} turns`} after it`;
}

/** A user message bubble with Copy and Edit; Edit swaps the bubble for an inline editor. */
export function Term2UserMessage({
  turnId,
  text,
  copied,
  onCopy,
  disabled,
  laterTurns,
  onResend,
}: {
  turnId: string;
  text: string;
  copied: boolean;
  onCopy: () => void;
  disabled: boolean;
  /** Turns after this one, which sending an edit removes. */
  laterTurns: number;
  onResend: ResendFromTurn;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!editing || !el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [editing, draft]);

  useEffect(() => {
    if (!editing) return;
    const el = textareaRef.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  const cancel = () => {
    setEditing(false);
    setError(null);
  };
  const send = async () => {
    const next = draft.trim();
    if (!next || busy) return;
    setBusy(true);
    setError(null);
    const failure = await onResend(turnId, next);
    setBusy(false);
    if (failure) setError(failure);
    else setEditing(false);
  };

  if (editing) {
    return (
      <div className="ml-auto w-full max-w-[85%] rounded-3xl bg-zinc-100 px-4 py-3 dark:bg-white/[0.07]">
        <textarea
          ref={textareaRef}
          value={draft}
          aria-label="Edit message"
          rows={1}
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              cancel();
            } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
          className="block w-full resize-none bg-transparent text-[15px] leading-6 outline-none"
        />
        <p className="mt-2 text-xs text-muted-foreground">
          Replaces this message and its reply{laterTurnsNote(laterTurns)}. File changes the agent made stay as they are.
        </p>
        {error && (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="mt-2 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={cancel}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={busy || disabled || !draft.trim()} onClick={() => void send()}>
            {busy && <Loader2 className="animate-spin" />}
            Send
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="max-w-[85%] rounded-3xl bg-zinc-100 px-4 py-2.5 dark:bg-white/[0.07]">
        <p className="whitespace-pre-wrap break-words text-[15px] leading-6">{text}</p>
      </div>
      <div className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
        <Button
          type="button"
          aria-label="Copy message"
          title="Copy message"
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground"
          onClick={onCopy}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
        <Button
          type="button"
          aria-label="Edit message"
          title="Edit message"
          disabled={disabled}
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground"
          onClick={() => {
            setDraft(text);
            setError(null);
            setEditing(true);
          }}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

/**
 * Retry under a reply: resend the turn's message as a new turn. Retrying an older reply
 * removes the turns after it, so that asks first.
 */
export function Term2RetryReply({
  turnId,
  userText,
  disabled,
  laterTurns,
  onResend,
  onError,
}: {
  turnId: string;
  userText: string;
  disabled: boolean;
  laterTurns: number;
  onResend: ResendFromTurn;
  onError: (message: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const retry = async () => {
    setBusy(true);
    const failure = await onResend(turnId, userText);
    setBusy(false);
    setConfirming(false);
    if (failure) onError(failure);
  };

  return (
    <>
      <Button
        type="button"
        aria-label="Retry reply"
        title="Retry"
        disabled={disabled || busy}
        variant="ghost"
        size="icon-xs"
        className="text-muted-foreground"
        onClick={() => (laterTurns > 0 ? setConfirming(true) : void retry())}
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
      </Button>
      <AlertDialog open={confirming} onOpenChange={(open) => !busy && setConfirming(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Retry this reply?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the reply{laterTurnsNote(laterTurns)}, then sends your message again. File changes the
              agent made stay as they are.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void retry();
              }}
            >
              {busy && <Loader2 className="animate-spin" />}
              Retry
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
