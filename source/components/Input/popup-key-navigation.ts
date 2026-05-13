type PopupKeyLike = {
  leftArrow?: boolean;
  rightArrow?: boolean;
  home?: boolean;
  end?: boolean;
  ctrl?: boolean;
};

type Args = {
  input: string;
  key: PopupKeyLike;
  cursor: number;
  valueLength: number;
  hasModeLeftHandler: boolean;
  hasModeRightHandler: boolean;
};

export function getPopupNavigationCursor({
  input,
  key,
  cursor,
  valueLength,
  hasModeLeftHandler,
  hasModeRightHandler,
}: Args): number | null {
  if (key.home || (key.ctrl && input === 'a')) {
    return 0;
  }

  if (key.end || (key.ctrl && input === 'e')) {
    return valueLength;
  }

  if (key.leftArrow && !hasModeLeftHandler) {
    return Math.max(0, cursor - 1);
  }

  if (key.rightArrow && !hasModeRightHandler) {
    return Math.min(valueLength, cursor + 1);
  }

  return null;
}
