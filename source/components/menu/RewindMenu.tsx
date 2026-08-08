import React, { FC } from 'react';
import { Box, Text } from 'ink';
import { REWIND_MENU_VISIBLE_ITEMS } from '../../hooks/use-rewind-selection.js';
import type { RewindItem } from '../../utils/conversation/rewind-items.js';
import type { RewindDisposition } from '../../commands/rewind-command.js';
import { MenuContainer } from '../common/MenuContainer.js';

type Props = {
  items: RewindItem[];
  selectedIndex: number;
  disposition: RewindDisposition;
  scrollOffset?: number;
  maxHeight?: number;
};

/**
 * Rows are two lines plus a separator, so fewer fit on screen than in a
 * single-line menu without pushing the transcript out of view.
 */
export const MAX_VISIBLE_ITEMS = REWIND_MENU_VISIBLE_ITEMS;

const TRUNCATE_LENGTH = 64;
/** Naming two files is concrete; naming ten is noise. */
const MAX_NAMED_FILES = 2;

const truncate = (text: string, maxLength: number): string => {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLength) return oneLine;
  return oneLine.slice(0, maxLength - 1) + '…';
};

const plural = (count: number, singular: string, pluralForm = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : pluralForm}`;

const basename = (path: string): string => path.split('/').filter(Boolean).pop() ?? path;

/**
 * The line that makes the rewind's cost legible before it happens. Rewinding
 * discards the turn and everything after it, and file edits already on disk are
 * not reverted — so naming the touched files matters more than counting them.
 */
function describeDiscards(item: RewindItem): string {
  if (item.discardedReplies === 0 && item.discardedFiles.length === 0) {
    return 'no reply yet';
  }

  const parts: string[] = [];
  if (item.discardedTurns > 1) {
    parts.push(plural(item.discardedTurns, 'turn'));
  }
  if (item.discardedReplies > 0) {
    parts.push(plural(item.discardedReplies, 'reply', 'replies'));
  }
  if (item.discardedFiles.length > 0) {
    const named = item.discardedFiles.slice(0, MAX_NAMED_FILES).map(basename).join(', ');
    const remaining = item.discardedFiles.length - MAX_NAMED_FILES;
    const suffix = remaining > 0 ? ` +${remaining}` : '';
    parts.push(`${plural(item.discardedFiles.length, 'file')} (${named}${suffix})`);
  }

  return `discards ${parts.join(' · ')}`;
}

const RewindMenu: FC<Props> = ({
  items,
  selectedIndex,
  disposition,
  scrollOffset = 0,
  maxHeight = MAX_VISIBLE_ITEMS,
}) => {
  const footer =
    disposition === 'edit'
      ? '⏎ rewind & edit · ⇥ resend instead · esc cancel · ↑↓ navigate'
      : '⏎ rewind & resend · ⇥ edit instead · esc cancel · ↑↓ navigate';

  return (
    <MenuContainer
      items={items}
      selectedIndex={selectedIndex}
      scrollOffset={scrollOffset}
      maxHeight={maxHeight}
      borderColor="yellow"
      fallbackText={<Text color="yellow">Nothing to rewind</Text>}
      footer={footer}
      footerOutsideBorder={true}
      renderItem={(item, index, isSelected) => {
        const images = item.imageCount > 0 ? ` [${plural(item.imageCount, 'image')}]` : '';
        const isLast = index === items.length - 1;
        return (
          <Box key={item.targetId} flexDirection="column">
            <Text inverse={isSelected} color={isSelected ? 'yellow' : undefined} bold={isSelected}>
              {`${isSelected ? '▸' : ' '} ${String(index + 1).padStart(2)}. ${truncate(
                item.text,
                TRUNCATE_LENGTH,
              )}${images}`}
            </Text>
            <Text color={isSelected ? 'yellow' : '#64748b'} dimColor={!isSelected}>
              {`      ↳ ${describeDiscards(item)}`}
            </Text>
            {/* Blank line between rows: two-line entries run together otherwise. */}
            {!isLast && <Text> </Text>}
          </Box>
        );
      }}
    />
  );
};

export default RewindMenu;
