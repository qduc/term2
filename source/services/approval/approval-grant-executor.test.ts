import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { applyApprovalGrant } from './approval-grant-executor.js';
import { resolveOutsideWorkspaceEdit } from './approval-descriptor.js';
import { SessionAccessState } from '../session/session-access-state.js';
import { createMockSettingsService } from '../settings/settings-service.mock.js';
import { createCreateFileToolDefinition } from '../../tools/file/create-file.js';
import { createApplyPatchToolDefinition } from '../../tools/file/apply-patch.js';
import { ExecutionContext } from '../execution-context.js';
import type { ILoggingService } from '../service-interfaces.js';

const logging = (): ILoggingService => ({
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  security: () => undefined,
  setCorrelationId: () => undefined,
  getCorrelationId: () => 'grant-scope-test',
  clearCorrelationId: () => undefined,
});

const noopPatchHealing = async (): Promise<{ wasModified: false }> => ({ wasModified: false });

function multiTargetOutsidePatch(docsFile: string, secretsFile: string): { patch: string } {
  return {
    patch: [
      '*** Begin Patch',
      `*** Add File: ${docsFile}`,
      '+a',
      `*** Add File: ${secretsFile}`,
      '+b',
      '*** End Patch',
    ].join('\n'),
  };
}

describe('applyApprovalGrant persistent edit scope', () => {
  const temps: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['allow-edit-folder-session', 'folder'],
    ['allow-edit-file-session', 'file'],
  ] as const)(
    'commits only the persistent %s scope the descriptor discloses for a multi-target outside patch',
    async (answer, scope) => {
      // os.tmpdir() is SANDBOX_TEMP_DIR here, which file tools treat as inside.
      // Put both roots under /tmp so the patch is a real outside-workspace approval.
      const workspaceDir = mkdtempSync('/tmp/term2-grant-workspace-');
      const outsideRoot = mkdtempSync('/tmp/term2-grant-outside-');
      temps.push(workspaceDir, outsideRoot);

      const disclosedFile = path.join(outsideRoot, 'docs', 'a.txt');
      const otherPatchFile = path.join(outsideRoot, 'secrets', 'b.txt');
      const undisclosedSibling = path.join(outsideRoot, 'secrets', 'unmentioned.txt');
      const laterInDisclosedFolder = path.join(outsideRoot, 'docs', 'later.txt');
      const args = multiTargetOutsidePatch(disclosedFile, otherPatchFile);

      // Displayed persistent scope: the production descriptor fields ApprovalPrompt interpolates.
      const descriptor = resolveOutsideWorkspaceEdit('apply_patch', args);
      expect(descriptor).toEqual({ path: disclosedFile, folder: path.dirname(disclosedFile) });
      if (!descriptor) throw new Error('expected outside-workspace descriptor');
      const disclosedPersistentPaths = scope === 'folder' ? [descriptor.folder] : [descriptor.path];
      expect(disclosedPersistentPaths).not.toContain(path.dirname(otherPatchFile));
      expect(disclosedPersistentPaths).not.toContain(otherPatchFile);

      const settings = createMockSettingsService({});
      const access = new SessionAccessState(settings);
      const allowEditFile = vi.spyOn(access, 'allowEditFile');
      const allowEditFolder = vi.spyOn(access, 'allowEditFolder');
      const executionContext = ExecutionContext.pin(workspaceDir);
      const applyPatch = createApplyPatchToolDefinition({
        loggingService: logging(),
        settingsService: settings,
        executionContext,
        sessionAccess: access,
        patchHealing: noopPatchHealing,
      });
      const createFile = createCreateFileToolDefinition({
        loggingService: logging(),
        settingsService: settings,
        executionContext,
        sessionAccess: access,
      });

      expect(await applyPatch.needsApproval(args)).toBe(true);

      const granted = applyApprovalGrant(
        { sessionId: 'grant-scope', sessionAccess: access, logger: logging() },
        { answer, toolName: 'apply_patch', rawArguments: args },
      );
      expect(granted.isApproved).toBe(true);

      const installed =
        scope === 'folder'
          ? allowEditFolder.mock.calls.map(([folder]) => folder)
          : allowEditFile.mock.calls.map(([file]) => file);
      expect(new Set(installed)).toEqual(new Set(disclosedPersistentPaths));
      if (scope === 'folder') expect(allowEditFile).not.toHaveBeenCalled();
      else expect(allowEditFolder).not.toHaveBeenCalled();

      const patchResult = await applyPatch.execute(args);
      expect(patchResult).toContain(`Created ${disclosedFile}`);
      expect(patchResult).toContain(`Created ${otherPatchFile}`);
      expect(readFileSync(disclosedFile, 'utf8')).toBe('a\n');
      expect(readFileSync(otherPatchFile, 'utf8')).toBe('b\n');

      expect(await createFile.needsApproval({ path: undisclosedSibling, content: 'secret', overwrite: false })).toBe(
        true,
      );
      expect(existsSync(undisclosedSibling)).toBe(false);

      if (scope === 'folder') {
        expect(
          await createFile.needsApproval({ path: laterInDisclosedFolder, content: 'later', overwrite: false }),
        ).toBe(false);
        await createFile.execute({ path: laterInDisclosedFolder, content: 'later', overwrite: false });
        expect(readFileSync(laterInDisclosedFolder, 'utf8')).toBe('later');
      } else {
        expect(await createFile.needsApproval({ path: disclosedFile, content: 'again', overwrite: true })).toBe(false);
        expect(
          await createFile.needsApproval({ path: laterInDisclosedFolder, content: 'later', overwrite: false }),
        ).toBe(true);
      }
    },
  );
});
