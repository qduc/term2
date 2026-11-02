import { queueAction } from './commands.js';
import type { TuiConnection } from './integration.js';
import type { QueueItem } from './state.js';
import { withSkillPrefix } from './skill-edit.js';

const USAGE = 'Use /queue resume|discard|retract <number>|edit <number> [text]|clear-images <number>.';

/**
 * `/queue resume|discard|retract|edit|clear-images`. Returns true when it opened a queued message for editing
 * (the caller then stops: nothing was sent), false once the queue command itself has been applied.
 */
export async function runQueueCommand(
  connection: TuiConnection,
  input: string,
  queue: readonly QueueItem[],
  owners: readonly string[] | null,
  startEdit: (item: QueueItem) => void,
): Promise<boolean> {
  const match = /^\/queue\s+(resume|discard|retract|edit|clear-images)(?:\s+(\d+))?(?:\s+([\s\S]*))?$/.exec(
    input.trim(),
  );
  if (!match) throw new Error(USAGE);
  const action = match[1] as 'resume' | 'discard' | 'retract' | 'edit' | 'clear-images';
  const item = match[2] ? queue[Number(match[2]) - 1] : undefined;
  if ((action === 'edit' || action === 'retract' || action === 'clear-images') && !item)
    throw new Error('No queued message at that number.');
  if (item && owners && owners[Number(match[2]) - 1] !== item.id)
    throw new Error('The queue changed. Check the list and re-enter your command.');
  if ((action === 'resume' || action === 'discard') && match[2])
    throw new Error('This operation takes no message number.');
  if (action === 'clear-images') {
    if (!item || match[3] !== undefined) throw new Error('Use /queue clear-images <number>.');
    if (!item.content) throw new Error('Queued content is unavailable; cannot safely clear images.');
    const primary = item.content.findIndex((part) => part.type === 'text');
    await queueAction(
      connection,
      'edit',
      item.id,
      item.text,
      item.content.filter((part, index) => index !== primary && part.type !== 'image'),
    );
    return false;
  }
  if (action === 'edit' && item && match[3] === undefined) {
    startEdit(item);
    return true;
  }
  const edited = action === 'edit' && match[3] !== undefined;
  await queueAction(
    connection,
    action,
    item?.id,
    edited ? withSkillPrefix(item?.skillEdit?.prefix, match[3]!) : match[3],
  );
  return false;
}
