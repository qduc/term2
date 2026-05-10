export type UserTurnImage = {
  id: string;
  data: string;
  mimeType: string;
  byteSize: number;
  displayNumber: number;
};

export type UserTurn = {
  text: string;
  images?: UserTurnImage[];
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
  };
}

export function hasUserTurnContent(turn: UserTurn): boolean {
  return Boolean(turn.text.trim() || turn.images?.length);
}

export function formatUserTurnForDisplay(turn: UserTurn): string {
  const text = turn.text;
  const imageCount = turn.images?.length ?? 0;
  if (imageCount === 0) {
    return text;
  }

  const suffix = `[${imageCount} ${imageCount === 1 ? 'image' : 'images'} attached]`;
  return text.trim() ? `${text}\n${suffix}` : suffix;
}
