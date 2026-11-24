'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { SecretFreeCredential } from '../../../lib/term2/types';

/** Where a credential comes from, in plain words. The gateway never returns the secret itself. */
export function credentialSourceText(source: SecretFreeCredential['source']): string {
  switch (source) {
    case 'setting':
      return 'saved in term2';
    case 'stored':
      return 'saved with this provider in term2';
    case 'environment':
      return 'from an environment variable';
    case 'token-file':
      return 'sign-in token';
    case 'local':
      return 'local server, no key needed';
    case 'external':
      return 'handled outside term2';
    default:
      return 'not set';
  }
}

/**
 * A masked API key with Replace and Remove. The key is only ever typed here and posted to the
 * gateway; it is never read back, so a saved key shows as dots.
 */
export function CredentialField({
  id,
  label,
  credential,
  disabled,
  onSave,
  onRemove,
}: {
  id: string;
  label: string;
  credential: SecretFreeCredential;
  disabled?: boolean;
  onSave: (value: string) => Promise<boolean>;
  onRemove?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const fromEnvironment = credential.source === 'environment';
  const showInput = !fromEnvironment && credential.writable && (editing || !credential.configured);

  if (fromEnvironment) {
    return (
      <p className="text-sm text-muted-foreground">
        <span className="font-mono tracking-widest text-foreground">••••••••</span>{' '}
        <span>from an environment variable</span>
      </p>
    );
  }

  if (!showInput && !credential.configured && !credential.writable) {
    return <p className="text-sm text-muted-foreground">Not set, and it can’t be set from here.</p>;
  }

  if (!showInput) {
    return (
      <div className="flex flex-wrap items-center justify-end gap-2">
        {credential.configured && (
          <span className="text-sm text-muted-foreground">
            <span className="font-mono tracking-widest text-foreground">••••••••</span>{' '}
            {credentialSourceText(credential.source)}
          </span>
        )}
        {credential.writable && (
          <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => setEditing(true)}>
            Replace
          </Button>
        )}
        {credential.configured && credential.writable && onRemove && (
          <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onRemove}>
            Remove
          </Button>
        )}
      </div>
    );
  }

  return (
    <form
      className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto"
      noValidate
      data-escape-cancels-edit
      onSubmit={async (event) => {
        event.preventDefault();
        if (!draft.trim() || saving) return;
        setSaving(true);
        try {
          if (await onSave(draft.trim())) {
            setDraft('');
            setEditing(false);
          }
        } finally {
          setSaving(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && credential.configured) {
          setDraft('');
          setEditing(false);
        }
      }}
    >
      {/* Lets password managers tell keys for different services apart. */}
      <input type="text" name="username" value={id} readOnly autoComplete="username" hidden />
      <Input
        type="password"
        autoComplete="new-password"
        aria-label={label}
        autoFocus={editing}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={credential.configured ? 'Paste the new key' : 'Paste API key'}
        className="min-w-0 flex-1 sm:w-56 sm:flex-none"
        disabled={disabled || saving}
      />
      <Button type="submit" size="sm" disabled={disabled || saving || !draft.trim()}>
        {saving && <Loader2 className="animate-spin" />}
        Save
      </Button>
      {editing && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setDraft('');
            setEditing(false);
          }}
        >
          Cancel
        </Button>
      )}
    </form>
  );
}
