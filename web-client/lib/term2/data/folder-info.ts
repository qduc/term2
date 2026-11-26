/** How a folder is named on screen: from what a folder pick returned, else its saved label. No React here. */
import type { WorkspaceAlias } from '../types';

export type FolderDetail = { readonly displayName: string; readonly fullPath: string; readonly access?: string };
export type FolderInfo = { readonly displayName: string; readonly fullPath: string; readonly access: string };

export function folderInfo(
  workspaceId: string | null,
  details: Readonly<Record<string, FolderDetail>>,
  folders: readonly WorkspaceAlias[],
): FolderInfo {
  if (!workspaceId) return { displayName: '', fullPath: '', access: 'read' };
  const meta = details[workspaceId];
  const ws = folders.find((w) => w.workspaceId === workspaceId);

  if (meta?.displayName) {
    return {
      displayName: meta.displayName,
      fullPath: meta.fullPath || meta.displayName,
      access: meta.access || ws?.access || 'read',
    };
  }
  if (ws?.label) {
    const label = ws.label;
    if (label.includes('/')) {
      const base = label.split('/').filter(Boolean).pop() || label;
      return { displayName: base, fullPath: label, access: ws.access || 'read' };
    }
    if (!label.startsWith('ws_')) {
      return { displayName: label, fullPath: label, access: ws.access || 'read' };
    }
  }
  return {
    displayName: 'Workspace',
    fullPath: ws?.label || workspaceId,
    access: ws?.access || 'read',
  };
}
