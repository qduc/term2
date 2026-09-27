export type UserTurnImage = {
  id: string;
  data: string;
  mimeType: string;
  byteSize: number;
  displayNumber: number;
};

export type SkillAttachment = {
  name: string;
  description: string;
  body: string;
};

export type UserTurn = {
  text: string;
  images?: UserTurnImage[];
  skill?: SkillAttachment;
};

const IMAGE_SENTINEL_PATTERN = /\uE000[^\uE000\uE001]*\uE001\s*/g;
const ORPHANED_IMAGE_SENTINEL_MARKER_PATTERN = /[\uE000\uE001]/g;

export function stripImageSentinels(text: string): string {
  return text.replace(IMAGE_SENTINEL_PATTERN, '').replace(ORPHANED_IMAGE_SENTINEL_MARKER_PATTERN, '');
}

export function normalizeUserTurn(input: string | UserTurn): UserTurn {
  if (typeof input === 'string') {
    return { text: stripImageSentinels(input) };
  }

  return {
    text: stripImageSentinels(input.text ?? ''),
    ...(input.images?.length ? { images: input.images } : {}),
    ...(input.skill ? { skill: input.skill } : {}),
  };
}

export function hasUserTurnContent(turn: UserTurn): boolean {
  return Boolean(turn.text.trim() || turn.images?.length);
}

export function formatUserTurnForDisplay(turn: UserTurn): string {
  const text = turn.text;
  const imageCount = turn.images?.length ?? 0;
  const skillName = turn.skill?.name;

  let result = text;

  if (skillName) {
    const skillPlaceholder = `[Skill: ${skillName}]`;
    result = result.trim() ? `${skillPlaceholder}\n${result}` : skillPlaceholder;
  }

  if (imageCount > 0) {
    const suffix = `[${imageCount} ${imageCount === 1 ? 'image' : 'images'} attached]`;
    result = result.trim() ? `${result}\n${suffix}` : suffix;
  }

  return result;
}

export function injectSkillIntoTurn(turn: UserTurn): UserTurn {
  if (!turn.skill) {
    return turn;
  }

  const wrapped = [
    '<system-notice>',
    'The user wants you to use this skill for the following request',
    '</system-notice>',
    '<skill>',
    turn.skill.body,
    '</skill>',
    '',
    '---',
    '',
  ].join('\n');

  return {
    ...turn,
    text: turn.text ? `${wrapped}\n\n${turn.text}` : wrapped,
  };
}
