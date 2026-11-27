'use client';

import { useState, type FormEvent } from 'react';
import { Loader2, Server } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { SshHostAlias, WorkspaceAlias } from '../../lib/term2/types';

export function Term2SshWorkspaceForm({
  allowWrite,
  hosts,
  loadingHosts,
  onConnect,
  onConnected,
}: {
  allowWrite: boolean;
  hosts: readonly SshHostAlias[];
  loadingHosts: boolean;
  onConnect: (body: {
    target: string;
    port?: number;
    directory?: string;
    access: 'read' | 'read_write';
  }) => Promise<WorkspaceAlias>;
  onConnected: (workspace: WorkspaceAlias) => void;
}) {
  const [target, setTarget] = useState('');
  const [directory, setDirectory] = useState('');
  const [port, setPort] = useState('');
  const [access, setAccess] = useState<'read' | 'read_write'>(allowWrite ? 'read_write' : 'read');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmedTarget = target.trim();
    if (!trimmedTarget) return;
    setConnecting(true);
    setError(null);
    try {
      const parsedPort = port.trim() ? Number(port.trim()) : undefined;
      if (parsedPort !== undefined && (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535)) {
        setError('Port must be a number between 1 and 65535.');
        return;
      }
      const workspace = await onConnect({
        target: trimmedTarget,
        ...(parsedPort !== undefined ? { port: parsedPort } : {}),
        ...(directory.trim() ? { directory: directory.trim() } : {}),
        access,
      });
      onConnected(workspace);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not connect to SSH host.');
    } finally {
      setConnecting(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
      <p className="text-xs leading-relaxed text-muted-foreground">
        Uses this server’s existing <code>~/.ssh/config</code>, SSH agent, and key files. Leave the remote directory
        blank to start in the remote home directory (<code>~</code>).
      </p>

      {!loadingHosts && hosts.length > 0 && (
        <div className="space-y-1.5">
          <span className="block text-xs font-medium text-muted-foreground">From ~/.ssh/config</span>
          <div className="flex flex-wrap gap-1.5">
            {hosts.map((entry) => (
              <Button
                key={entry.alias}
                type="button"
                size="sm"
                variant={target.trim() === entry.alias ? 'default' : 'outline'}
                className="h-7 gap-1.5 px-2.5 text-xs"
                onClick={() => {
                  setTarget(entry.alias);
                  setPort(entry.port ? String(entry.port) : '');
                  setError(null);
                }}
              >
                <Server aria-hidden className="size-3" />
                {entry.alias}
              </Button>
            ))}
          </div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
        <div className="space-y-1">
          <label htmlFor="ssh-target" className="block text-xs font-medium text-foreground">
            Host or user@host
          </label>
          <Input
            id="ssh-target"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="prod-box or ubuntu@10.0.0.5"
            autoComplete="off"
            disabled={connecting}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="ssh-port" className="block text-xs font-medium text-foreground">
            Port
          </label>
          <Input
            id="ssh-port"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            placeholder="22"
            inputMode="numeric"
            autoComplete="off"
            disabled={connecting}
          />
        </div>
      </div>

      <div className="space-y-1">
        <label htmlFor="ssh-directory" className="block text-xs font-medium text-foreground">
          Remote directory <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <Input
          id="ssh-directory"
          value={directory}
          onChange={(e) => setDirectory(e.target.value)}
          placeholder="~ (any directory)"
          autoComplete="off"
          disabled={connecting}
        />
      </div>

      <div className="flex items-center justify-between gap-3 pt-1">
        <div className="flex items-center gap-1.5 text-xs">
          <Button
            type="button"
            size="sm"
            variant={access === 'read_write' ? 'secondary' : 'ghost'}
            disabled={!allowWrite || connecting}
            title={!allowWrite ? 'Server was started with --read-only' : undefined}
            onClick={() => setAccess('read_write')}
          >
            Read &amp; write
          </Button>
          <Button
            type="button"
            size="sm"
            variant={access === 'read' ? 'secondary' : 'ghost'}
            disabled={connecting}
            onClick={() => setAccess('read')}
          >
            Read only
          </Button>
        </div>

        <Button type="submit" size="sm" disabled={connecting || !target.trim()}>
          {connecting ? (
            <>
              <Loader2 aria-hidden className="size-3.5 animate-spin" />
              Connecting…
            </>
          ) : (
            'Connect SSH'
          )}
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
