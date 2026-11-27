'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useStoreSelector } from '../../../hooks/useStoreSelector';
import { Term2FolderSelector } from '../Term2FolderSelector';
import { Term2HelpDialog } from '../Term2HelpDialog';
import { Term2ProviderSetup } from '../Term2ProviderSetup';
import { Term2RewindDialog } from '../Term2RewindDialog';
import { Term2SetupDialog } from '../Term2SetupDialog';
import { Term2SshWorkspaceForm } from '../Term2SshWorkspaceForm';
import { useAllowWrite, useChatFacts, useShell, useShellEnv, useShellState } from './ShellContext';

const useCloseDialog = () => {
  const { dispatch } = useShell();
  return () => dispatch({ type: 'DIALOG_CLOSED' });
};

/** Connect a first provider. */
export function ProviderDialog() {
  const shell = useShell();
  const close = useCloseDialog();
  const open = useShellState((s) => s.panels.dialog === 'provider');
  const settings = useStoreSelector(shell.data.settings, (s) => s.data);
  const models = useStoreSelector(shell.data.models, (s) => s);
  if (!open || !settings) return null;
  return (
    <Term2ProviderSetup
      projection={settings}
      models={models.data}
      modelsLoading={models.loading}
      onContinue={shell.ops.providerChosen}
      onClose={close}
    />
  );
}

export function FolderDialog() {
  const shell = useShell();
  const close = useCloseDialog();
  const { homeFolder } = useShellEnv();
  const open = useShellState((s) => s.panels.dialog === 'folder');
  const folders = useStoreSelector(shell.data.folders, (s) => s.data);
  const sshHosts = useStoreSelector(shell.data.sshHosts, (s) => s);
  const selectedWorkspaceId = useChatFacts((f) => f.selectedWorkspaceId);
  const allowWrite = useAllowWrite();
  const [tab, setTab] = useState<'local' | 'ssh'>('local');
  if (!open) return null;
  return (
    <Term2SetupDialog title="Choose a folder" wide onClose={close}>
      <div className="mb-3 flex items-center gap-1 border-b border-border pb-2">
        <Button
          type="button"
          size="sm"
          variant={tab === 'local' ? 'secondary' : 'ghost'}
          onClick={() => setTab('local')}
        >
          Local folder
        </Button>
        <Button
          type="button"
          size="sm"
          variant={tab === 'ssh' ? 'secondary' : 'ghost'}
          onClick={() => {
            setTab('ssh');
            shell.data.sshHosts.ensure();
          }}
        >
          SSH remote
        </Button>
      </div>
      {tab === 'local' ? (
        <Term2FolderSelector
          homeFolder={homeFolder}
          allowWrite={allowWrite}
          savedWorkspaces={folders}
          selectedWorkspaceId={selectedWorkspaceId}
          onSelectExisting={(workspaceId) => {
            close();
            shell.ops.createNewChat(workspaceId);
          }}
          onSelected={shell.ops.folderSelected}
          onSavedFolderChanged={(change) => void shell.ops.savedFolderChanged(change)}
        />
      ) : (
        <Term2SshWorkspaceForm
          allowWrite={allowWrite}
          hosts={sshHosts.data}
          loadingHosts={sshHosts.loading}
          onConnect={(body) => shell.data.addSshWorkspace(body)}
          onConnected={(workspace) => {
            close();
            shell.ops.createNewChat(workspace.workspaceId);
          }}
        />
      )}
    </Term2SetupDialog>
  );
}

export function HelpDialog() {
  const close = useCloseDialog();
  const open = useShellState((s) => s.panels.dialog === 'help');
  const allowWrite = useAllowWrite();
  if (!open) return null;
  return (
    <Term2SetupDialog title="Help & shortcuts" onClose={close}>
      <Term2HelpDialog allowWrite={allowWrite} />
    </Term2SetupDialog>
  );
}

export function RewindDialog() {
  const shell = useShell();
  const close = useCloseDialog();
  const open = useShellState((s) => s.panels.dialog === 'rewind');
  const sessionId = useChatFacts((f) => f.sessionId);
  if (!open || !sessionId) return null;
  return (
    <Term2SetupDialog title="Rewind conversation" onClose={close}>
      <Term2RewindDialog sessionId={sessionId} onRewind={shell.ops.rewind} onClose={close} />
    </Term2SetupDialog>
  );
}
