/**
 * Settings writes, one at a time, each against the revision the store holds when its turn comes, so a second change
 * made while the first is saving is not refused as a conflict (docs/plans/web-client/web-shell-decomposition-part2.md,
 * section 3.3). A failed write does not stop the next. After a conflict the server's projection is installed, so the
 * next write uses the server's revision, and the conflicting write rejects. No facade import, so the generated
 * property web.settings-writes-in-order can load it. No React here.
 */
import type { SettingsProjection } from '../types';
import type { Resource } from './resource';

export type SettingsChange = { readonly key: string; readonly value: unknown };

export function createSettingsWriter(deps: {
  settings: Resource<SettingsProjection | null>;
  write(input: { expectedRevision: string; changes: SettingsChange[] }): Promise<{ projection: SettingsProjection }>;
  /** The projection a conflict error carries, or null for any other error. */
  conflictProjection(error: unknown): SettingsProjection | null;
}): (changes: SettingsChange[]) => Promise<SettingsProjection> {
  let chain: Promise<unknown> = Promise.resolve();
  return (changes) => {
    const run = async (): Promise<SettingsProjection> => {
      const current = deps.settings.get().data;
      if (!current) throw new Error('Settings are not loaded.');
      try {
        const result = await deps.write({ expectedRevision: current.revision, changes });
        deps.settings.set(result.projection);
        return result.projection;
      } catch (error) {
        const projection = deps.conflictProjection(error);
        if (projection) deps.settings.set(projection);
        throw error;
      }
    };
    // The caller gets its own write's outcome; the chain only orders the writes.
    const mine = chain.then(run, run);
    chain = mine.catch(() => undefined);
    return mine;
  };
}
